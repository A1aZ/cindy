import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useVoiceInputSettings } from '@/hooks/useVoiceInputSettings';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useVoiceInput, type VoiceInputTextTarget } from '@/voice-input/useVoiceInput';
import { isVoiceInputEventScopeActive } from '@/voice-input/eventScope';
import { formatVoiceInputShortcut } from '@/voice-input/shortcut';
import { playVoiceInputEndCue, playVoiceInputStartCue } from '@/voice-input/startCue';

// Both composers subscribe to the native shortcut. One gesture belongs to the
// input focused at its start, including release after focus moves elsewhere.
let activeComposer: symbol | null = null;

export function useBotGroupVoiceInput({
  draftKey, textareaRef, text, onChange, disabled,
}: {
  draftKey: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onChange: (text: string) => void;
  disabled: boolean;
}) {
  const { settings } = useVoiceInputSettings();
  const identity = useRef(Symbol('group-dictation')).current;
  const mounted = useRef(false);
  const current = useRef({ draftKey, text, onChange, disabled });
  current.current = { draftKey, text, onChange, disabled };
  const owner = useRef<ReturnType<typeof getDataOwnerGeneration> | null>(null);
  const startedDraft = useRef<string | null>(null);
  const expectedText = useRef('');
  const caret = useRef<number | null>(null);
  const canApply = useCallback(() => mounted.current
    && !current.current.disabled
    && startedDraft.current === current.current.draftKey
    && owner.current !== null && isDataOwnerGenerationCurrent(owner.current)
    && current.current.text === expectedText.current, []);

  // Runs before the shared hook's cleanup: pending focus/ASR callbacks cannot
  // write through a stale target after leaving this group or closing a thread.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (activeComposer === identity) activeComposer = null;
    };
  }, [identity]);

  const target = useMemo<VoiceInputTextTarget>(() => ({
    getText: () => current.current.text,
    getSelection: () => ({
      from: textareaRef.current?.selectionStart ?? current.current.text.length,
      to: textareaRef.current?.selectionEnd ?? current.current.text.length,
    }),
    replace: (range, inserted) => {
      if (!canApply() || range.from < 0 || range.to > current.current.text.length || range.to < range.from) return null;
      const value = current.current.text.slice(0, range.from) + inserted + current.current.text.slice(range.to);
      expectedText.current = value;
      current.current.text = value;
      current.current.onChange(value);
      caret.current = range.from + inserted.length;
      return { start: range.from, end: caret.current };
    },
    focus: () => {
      if (!canApply()) return;
      const input = textareaRef.current;
      // Finishing a main-group recording must not steal the thread's focus.
      if (!input || document.activeElement !== input) return;
      if (caret.current !== null) input.setSelectionRange(caret.current, caret.current);
    },
  }), [canApply, textareaRef]);
  const voice = useVoiceInput(null, disabled, undefined, { textTarget: target, shouldApplyToEditor: canApply });
  const latest = useRef({ voice, settings });
  latest.current = { voice, settings };

  const start = useCallback(() => {
    if (current.current.disabled || !mounted.current || (activeComposer !== null && activeComposer !== identity)) return false;
    owner.current = getDataOwnerGeneration();
    startedDraft.current = current.current.draftKey;
    expectedText.current = current.current.text;
    caret.current = null;
    const { voice: input, settings: config } = latest.current;
    const claimed = input.start({
      onStartFeedback: () => { if (config.playInteractionSound) return playVoiceInputStartCue(); },
    });
    if (claimed) activeComposer = identity;
    return claimed;
  }, [identity]);

  const stop = useCallback(() => latest.current.voice.stop({
    waitForRefinement: true,
    onReadyForEndCue: () => { if (latest.current.settings.playInteractionSound) playVoiceInputEndCue(); },
  }).catch(() => undefined), []);

  useEffect(() => {
    if (!voice.isBusy && activeComposer === identity) activeComposer = null;
  }, [identity, voice.isBusy]);

  useEffect(() => {
    if (voice.isBusy && !canApply()) void voice.cancel();
  }, [canApply, draftKey, disabled, text, voice.isBusy, voice.cancel]);

  useEffect(() => {
    let startedOnPress = false;
    let suppressRelease = false;
    return window.electronAPI?.voiceInput?.onGlobalShortcutTrigger((payload) => {
      if (current.current.disabled || (activeComposer !== null && activeComposer !== identity)) return;
      const state = latest.current.voice.getState();
      if (!isVoiceInputEventScopeActive(state) && document.activeElement !== textareaRef.current) return;
      if (payload?.id) window.electronAPI.voiceInput.claimGlobalShortcutTrigger(payload.id);
      const phase = payload?.phase;
      if (phase === 'end' || phase === 'tap') {
        if (suppressRelease) { suppressRelease = false; return; }
        if (phase === 'tap' && startedOnPress) { startedOnPress = false; return; }
        startedOnPress = false;
        if (state === 'listening') void stop();
        return;
      }
      if (state === 'submitting' || state === 'refining') return;
      if (state === 'listening') {
        suppressRelease = phase === 'start';
        startedOnPress = false;
        void stop();
      } else {
        startedOnPress = phase === 'start' && start();
        if (phase !== 'start') start();
      }
    });
  }, [identity, start, stop, textareaRef]);

  const range = voice.draftRange;
  const displayText = voice.isBusy && range && voice.draftText && canApply()
    ? text.slice(0, range.from) + voice.draftText + text.slice(range.to)
    : text;
  return { ...voice, start, stop, displayText, shortcutLabel: formatVoiceInputShortcut(settings.shortcut) };
}
