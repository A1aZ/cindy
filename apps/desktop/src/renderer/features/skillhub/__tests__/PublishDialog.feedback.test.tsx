// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(), refresh: vi.fn(), sync: vi.fn(), publish: vi.fn(),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { membershipKind: 'personal', orgSlug: null } }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../hooks/useSkillhub', () => ({ refresh: mocks.refresh }));
vi.mock('../hooks/useSkillSync', () => ({ triggerIncrementalSync: mocks.sync }));
vi.mock('../hooks/useSkillFolderHash', () => ({ invalidateHash: vi.fn() }));
vi.mock('../components/PlatformTagSelector', () => ({ PlatformTagSelector: () => null }));

import { PublishDialog } from '../PublishDialog';

let progress!: (event: SkillhubPublishProgressEvent) => void;
const feedback: SkillhubPublishProgressEvent = {
  phase: 'scan-result', name: 'review-helper', version: '1.0.1', status: 'rejected',
  rejectionReason: 'Private owner feedback', gates: [],
  ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner-a', 1);
  mocks.refresh.mockReset().mockResolvedValue([]);
  mocks.confirm.mockResolvedValue(true);
  mocks.publish.mockResolvedValue({ success: true, result: { name: 'review-helper', version: '1.0.1' } });
  vi.stubGlobal('electronAPI', { skillhub: {
    publish: mocks.publish,
    onPublishProgress: (listener: typeof progress) => { progress = listener; return () => {}; },
  } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function startPublication() {
  const onScanResult = vi.fn();
  const onOpenChange = vi.fn();
  render(<PublishDialog open onOpenChange={onOpenChange} onScanResult={onScanResult}
    isFirstPublish={false} latestVersion="1.0.0" skill={{
      id: 'review-helper', urlKey: 'review-helper', engine: 'claude-code', linkedEngines: [],
      kind: 'skill', scope: 'global', mdPath: '/fixture/review-helper/SKILL.md', files: [], registryEntry: null,
      name: 'review-helper', absolutePath: '/fixture/review-helper', frontmatter: { version: '1.0.1' },
    }} />);
  fireEvent.change(screen.getByPlaceholderText('skillhub.publishDialog.changelogPlaceholder'), { target: { value: 'Improve documentation' } });
  fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishDialog.startPublish' }));
  await waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce());
  return { onScanResult, onOpenChange };
}

describe('PublishDialog result delivery', () => {
  it.each(['unchanged', 'different-owner', 'same-owner-new-generation'] as const)(
    'forwards feedback after refresh only when the owner is %s', async (transition) => {
      let finishRefresh!: (value: unknown[]) => void;
      mocks.refresh.mockReturnValueOnce(new Promise((resolve) => { finishRefresh = resolve; }));
      const { onScanResult, onOpenChange } = await startPublication();
      act(() => progress(feedback));
      expect(mocks.refresh).toHaveBeenCalledOnce();
      if (transition === 'different-owner') setDataOwnerGeneration('owner-b', 2);
      if (transition === 'same-owner-new-generation') {
        setDataOwnerGeneration('owner-b', 2);
        setDataOwnerGeneration('owner-a', 3);
      }
      await act(async () => { finishRefresh([]); });
      if (transition === 'unchanged') {
        expect(onScanResult).toHaveBeenCalledWith({ status: 'rejected', gates: [], rejectionReason: 'Private owner feedback' });
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(mocks.sync).toHaveBeenCalledWith(['review-helper']);
      } else {
        expect(onScanResult).not.toHaveBeenCalled();
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(mocks.sync).not.toHaveBeenCalled();
      }
    },
  );

  it('ignores an old-owner frame already queued before it reaches the renderer', async () => {
    const { onScanResult } = await startPublication();
    setDataOwnerGeneration('owner-b', 2);
    await act(async () => progress(feedback));
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(onScanResult).not.toHaveBeenCalled();
  });
});
