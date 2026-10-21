// @vitest-environment jsdom
// #6650: real group hook + shared dictation lifecycle, with only native capture/IPC
// faked. Existing rich-editor tests cannot exercise two textarea owners or late
// startup after closing a thread. Unit tier: no devices, network or real waits.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceInputRendererEvent } from '@cindy/voice-input-core';

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  expired: vi.fn(),
  settings: { language: 'auto', refinementEnabled: true, fastActivationEnabled: false, shortcut: null, dictionaryEntries: [], refinementInstructions: '' },
  guards: vi.fn(),
  owner: { dataOwnerId: 'test-owner', generation: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/hooks/useCodexSessionExpiredPrompt', () => ({
  useCodexSessionExpiredPrompt: () => mocks.expired, isCodexSessionExpiredError: () => false,
}));
vi.mock('@/hooks/useVoiceInputSettings', () => ({
  useVoiceInputSettings: () => ({ settings: mocks.settings }), adviseAndRecordVoiceInputDictionaryLearning: vi.fn(),
  getVoiceInputSettings: () => mocks.settings,
}));
vi.mock('@/hooks/useVoiceInputHistory', () => ({ recordVoiceInputHistory: () => null, updateVoiceInputHistoryEntry: vi.fn(), getVoiceInputHistoryForRefinement: () => [] }));
vi.mock('@/hooks/useVoiceInputUsageStats', () => ({ recordVoiceInputUsage: vi.fn(), recordVoiceInputRefinementUsage: vi.fn() }));
vi.mock('@/voice-input/workletUrl', () => ({ getVoiceInputWorkletUrl: () => '' }));
vi.mock('@/voice-input/audioContextPool', () => ({ prewarmVoiceInputAudio: async () => {} }));
vi.mock('@/voice-input/WebMicAudioEngine', () => ({
  disposeKeepAliveVoiceInputMicrophone: async () => {}, prewarmVoiceInputBenchmarkFixture: async () => {},
  isMicrophoneDeviceUnavailableError: () => false, isSelectedMicrophoneUnavailableError: () => false,
}));
vi.mock('@/voice-input/startGuards', () => ({ resolveVoiceInputStartGuards: mocks.guards }));
vi.mock('@/voice-input/captureSession', () => ({
  startVoiceInputCaptureSession: async (input: { onSoundDetected: () => void }) => {
    input.onSoundDetected();
    return { ok: true, drainPendingChunks: () => {} };
  },
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ ...mocks.owner }),
  isDataOwnerGenerationCurrent: (owner: typeof mocks.owner) => owner.generation === mocks.owner.generation,
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/new-chat/ComposerAttachments', () => ({ AttachmentRejectionStrip: () => null, ThumbnailStrip: () => null }));

import { useBotGroupVoiceInput } from '../useBotGroupVoiceInput';
import { BotGroupComposer } from '../BotGroupComposer';
import { Tooltip } from '@/components/ui/tooltip';
import { armDetachedVoiceDraftPersist, clearArmedDetachedVoiceDraft, hasArmedDetachedVoiceDraft } from '@/components/new-chat/composerSendOwnership';

type Trigger = { id: string; phase?: 'start' | 'tap' | 'end' };
const events = new Set<(event: VoiceInputRendererEvent) => void>();
const shortcuts = new Set<(event: Trigger) => void>();
const emit = (event: VoiceInputRendererEvent) => events.forEach(listener => listener(event));
const trigger = (phase?: Trigger['phase']) => shortcuts.forEach(listener => listener({ id: 'gesture', phase }));
const api = {
  onEvent: (listener: (event: VoiceInputRendererEvent) => void) => { events.add(listener); return () => events.delete(listener); },
  onGlobalShortcutTrigger: (listener: (event: Trigger) => void) => { shortcuts.add(listener); return () => shortcuts.delete(listener); },
  claimGlobalShortcutTrigger: vi.fn(),
  prewarm: vi.fn().mockResolvedValue({ ok: true }),
  start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), drainAudioQueue: vi.fn().mockResolvedValue(undefined),
};
const segment = { id: 'segment', source: 'mic' as const, status: 'submitted' as const, text: 'spoken', updatedAt: 1 };
function submit(runId = 'run') {
  emit({ type: 'submitted', runId, text: 'spoken', segment });
}
function refine(text = 'Spoken.') {
  emit({ type: 'refined', runId: 'run', text, segment: { ...segment, status: 'refined' },
    range: { id: 'range', segmentIds: ['segment'], startOffset: 0, endOffset: 6, userTouched: false } });
}
function Harness({ id, initial = '', disabled = false }: { id: string; initial?: string; disabled?: boolean }) {
  const [text, setText] = useState(initial);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voice = useBotGroupVoiceInput({ draftKey: id, text, onChange: setText, textareaRef, disabled });
  return <div>
    <textarea aria-label={id} ref={textareaRef} value={voice.displayText} readOnly={voice.isBusy} onChange={event => setText(event.target.value)} />
    <output data-testid={`${id}-saved`}>{text}</output>
    <output data-testid={`${id}-state`}>{voice.state}</output>
    <button onClick={() => voice.start()}>start {id}</button>
    <button onClick={() => { void voice.stop(); }}>stop {id}</button>
  </div>;
}
const input = (id: string) => screen.getByRole('textbox', { name: id }) as HTMLTextAreaElement;
const start = async (id: string) => { await act(async () => { fireEvent.click(screen.getByText(`start ${id}`)); }); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.owner.generation = 1;
  mocks.guards.mockResolvedValue({ ok: true, permission: { ok: true }, readiness: { ok: true } });
  api.start.mockResolvedValue({ ok: true, runId: 'run' });
  api.cancel.mockResolvedValue({ ok: true });
  api.stop.mockImplementation(async () => { submit(); refine(); emit({ type: 'state', runId: 'run', state: 'done' }); return { ok: true }; });
  vi.stubGlobal('electronAPI', { platform: 'win32', voiceInput: api });
});
afterEach(() => { cleanup(); clearArmedDetachedVoiceDraft(); events.clear(); shortcuts.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('group textarea dictation ownership (#6650)', () => {
  it('the real reply composer stops on Enter, retains the transcript, and sends only after manual editing', async () => {
    const sendReply = vi.fn().mockResolvedValue({ ok: true, messageId: 'reply' });
    render(<Tooltip.Provider><BotGroupComposer groupId="group" draftKey="voice-test-thread" mode="thread"
      members={[]} running={false} sendReply={sendReply} /></Tooltip.Provider>);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'newChat.chatInput.voiceInput.start' })));
    const textbox = screen.getByRole('textbox');
    expect((textbox as HTMLTextAreaElement).readOnly).toBe(true);
    await act(async () => fireEvent.keyDown(textbox, { key: 'Enter' }));
    expect((textbox as HTMLTextAreaElement).value).toBe('Spoken.');
    expect(sendReply).not.toHaveBeenCalled();
    fireEvent.change(textbox, { target: { value: 'Edited reply' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.server.sendReply' })));
    expect(sendReply).toHaveBeenCalledWith(expect.objectContaining({ text: 'Edited reply' }));
  });

  it('previews at the selection, refines into the draft and leaves it editable', async () => {
    render(<Harness id="group" initial={'before\nreplace after'} />);
    input('group').focus(); input('group').setSelectionRange(7, 14);
    await start('group');
    act(() => emit({ type: 'draft', runId: 'run', text: 'partial', source: 'partial', segment }));
    expect(input('group').value).toBe('before\npartial after');
    expect(screen.getByTestId('group-saved').textContent).toBe('before\nreplace after');
    await act(async () => { fireEvent.click(screen.getByText('stop group')); });
    expect(input('group').value).toBe('before\nSpoken. after');
    expect(input('group').readOnly).toBe(false);
    fireEvent.change(input('group'), { target: { value: 'edited' } });
    expect(screen.getByTestId('group-saved').textContent).toBe('edited');
  });

  it('routes a press and release to the focused thread, even after focus moves', async () => {
    render(<><Harness id="group" initial="main draft" /><Harness id="thread" /></>);
    input('thread').focus();
    await act(async () => trigger('start'));
    input('group').focus();
    await act(async () => trigger('end'));
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(input('thread').value).toBe('Spoken.');
    expect(input('group').value).toBe('main draft');
    act(() => vi.advanceTimersByTime(20));
    expect(document.activeElement).toBe(input('group'));
  });

  it('keeps listening on first tap release and stops on the next press', async () => {
    render(<Harness id="group" />); input('group').focus();
    await act(async () => trigger('start'));
    act(() => trigger('tap'));
    expect(api.stop).not.toHaveBeenCalled();
    await act(async () => trigger('start'));
    act(() => trigger('tap'));
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(input('group').value).toBe('Spoken.');
  });

  it('closing an idle thread does not cancel main-group dictation', async () => {
    const view = render(<><Harness key="group" id="group" /><Harness key="thread" id="thread" /></>);
    await start('group');
    view.rerender(<><Harness key="group" id="group" /></>);
    expect(api.cancel).not.toHaveBeenCalled();
    act(() => submit());
    expect(input('group').value).toBe('spoken');
  });

  it('cancels an unmounted owner by run ID and ignores its late result in the new group', async () => {
    const view = render(<Harness key="old" id="old" />);
    await start('old');
    view.rerender(<Harness key="new" id="new" initial="new draft" />);
    expect(api.cancel).toHaveBeenCalledWith({ runId: 'run' });
    act(() => { submit(); refine(); });
    expect(input('new').value).toBe('new draft');
  });

  it('cancels a late startup without accepting events from another run', async () => {
    let resolve!: (result: { ok: true; runId: string }) => void;
    api.start.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<Harness key="old" id="old" />);
    await start('old');
    act(() => submit('unrelated'));
    expect(input('old').value).toBe('');
    view.rerender(<Harness key="new" id="new" />);
    await act(async () => { resolve({ ok: true, runId: 'late' }); });
    expect(api.cancel).toHaveBeenCalledWith({ runId: 'late' });
    expect(input('new').value).toBe('');
  });

  it('unmounting a group cancels only its run while ordinary chat preserves a detached draft', async () => {
    const view = render(<Harness id="group" />);
    await start('group');
    armDetachedVoiceDraftPersist('ordinary-chat', '');
    view.unmount();
    expect(api.cancel).toHaveBeenCalledWith({ runId: 'run' });
    expect(api.stop).not.toHaveBeenCalled();
    expect(hasArmedDetachedVoiceDraft('ordinary-chat')).toBe(true);
    expect(events.size).toBe(0);
  });

  it.each(['draft', 'account', 'disabled'] as const)('rejects results after a %s boundary change', async boundary => {
    const view = render(<Harness id="group" initial="original" />);
    await start('group');
    if (boundary === 'account') mocks.owner.generation++;
    if (boundary === 'disabled') view.rerender(<Harness id="group" initial="original" disabled />);
    if (boundary === 'draft') view.rerender(<Harness id="other-draft" initial="original" />);
    await act(async () => { submit(); refine(); });
    expect(screen.getByRole('textbox').getAttribute('aria-label')).toBe(boundary === 'draft' ? 'other-draft' : 'group');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('original');
  });

  it('retains user edits if a refinement arrives late', async () => {
    render(<Harness id="group" />); await start('group');
    act(() => submit());
    fireEvent.change(input('group'), { target: { value: 'manual correction' } });
    await act(async () => refine());
    expect(input('group').value).toBe('manual correction');
  });

  it('shows permission failure and restores editing', async () => {
    mocks.guards.mockResolvedValue({ ok: false, permission: { ok: false, error: 'permission denied' }, readiness: { ok: true } });
    render(<Harness id="group" initial="draft" />); await start('group');
    expect(api.start).not.toHaveBeenCalled();
    expect(input('group').readOnly).toBe(false);
    expect(input('group').value).toBe('draft');
    expect(screen.getByTestId('group-state').textContent).toBe('error');
  });
});
