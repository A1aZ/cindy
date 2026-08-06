// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  onContextMenu: vi.fn(),
  openTurnReview: vi.fn(async () => undefined),
  shouldOpenTextLightboxForOrigin: vi.fn(async () => true),
  useFileChipContextMenu: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number }) =>
      values?.count === undefined ? key : `${key}:${values.count}`,
  }),
}));

vi.mock('@/features/right-sidebar/lib/openTurnReview', () => ({
  openTurnReview: mocks.openTurnReview,
}));

vi.mock('@/lib/filePreview', () => ({
  shouldOpenTextLightboxForOrigin: mocks.shouldOpenTextLightboxForOrigin,
}));

vi.mock('../TextLightbox', () => ({
  TextLightbox: ({ filePath, fileName }: { filePath: string; fileName: string }) => (
    <div data-testid="text-lightbox">{`${fileName}:${filePath}`}</div>
  ),
}));

vi.mock('../useFileChipContextMenu', () => ({
  useFileChipContextMenu: mocks.useFileChipContextMenu,
}));

import { TurnChangesCard } from '../TurnChangesCard';
import type { TurnChangeSetSummary } from '../../../../shared/turnChangeSet';

const CHANGE_SET: TurnChangeSetSummary = {
  id: 'change-1',
  sessionId: 'session-1',
  anchorClientId: 'user-1',
  provider: 'codex',
  providerTurnId: 'turn-1',
  cwd: 'C:\\repo',
  state: 'complete',
  incompleteReasons: [],
  createdAt: 1,
  completedAt: 2,
  files: [{
    id: 'file-1',
    path: 'src/test.ts',
    oldPath: null,
    status: 'modified',
    additions: 3,
    deletions: 1,
  }],
  fileCount: 1,
  additions: 3,
  deletions: 1,
};

const HTML_CHANGE_SET: TurnChangeSetSummary = {
  ...CHANGE_SET,
  files: [{
    ...CHANGE_SET.files[0],
    id: 'file-html',
    path: 'web/page.html',
  }],
};

describe('TurnChangesCard file actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useFileChipContextMenu.mockReturnValue({
      onContextMenu: mocks.onContextMenu,
      openAt: vi.fn(),
      menu: <div>file-context-menu</div> as ReactNode,
    });
  });

  it('opens the shared file context menu with the turn cwd resolved path', () => {
    render(<TurnChangesCard sessionId="session-1" changeSet={CHANGE_SET} />);

    const fileRow = screen.getByRole('button', { name: /src\/test\.ts/ });
    fireEvent.contextMenu(fileRow);

    expect(mocks.onContextMenu).toHaveBeenCalledTimes(1);
    expect(mocks.useFileChipContextMenu).toHaveBeenCalledTimes(1);
    const [{ getAbsPath, canOpenInBrowser, sidebarOpenSessionId, onViewSource }] =
      mocks.useFileChipContextMenu.mock.calls[0] as [{
      getAbsPath: () => string;
      canOpenInBrowser: boolean;
      sidebarOpenSessionId?: string;
      onViewSource?: () => Promise<void>;
    }];
    expect(getAbsPath()).toBe('C:\\repo\\src\\test.ts');
    expect(canOpenInBrowser).toBe(false);
    expect(sidebarOpenSessionId).toBeUndefined();
    expect(onViewSource).toBeUndefined();
    expect(screen.getByText('file-context-menu')).toBeTruthy();
  });

  it('matches markdown HTML file actions and lazily opens the current source', async () => {
    render(<TurnChangesCard sessionId="session-1" changeSet={HTML_CHANGE_SET} />);

    const [{ getAbsPath, canOpenInBrowser, sidebarOpenSessionId, onViewSource }] =
      mocks.useFileChipContextMenu.mock.calls[0] as [{
        getAbsPath: () => string;
        canOpenInBrowser: boolean;
        sidebarOpenSessionId?: string;
        onViewSource?: () => Promise<void>;
      }];

    expect(getAbsPath()).toBe('C:\\repo\\web\\page.html');
    expect(canOpenInBrowser).toBe(true);
    expect(sidebarOpenSessionId).toBe('session-1');
    expect(onViewSource).toEqual(expect.any(Function));
    expect(mocks.shouldOpenTextLightboxForOrigin).not.toHaveBeenCalled();

    await act(async () => {
      await onViewSource?.();
    });

    expect(mocks.shouldOpenTextLightboxForOrigin).toHaveBeenCalledWith(
      expect.objectContaining({ origin: { kind: 'local' } }),
      'C:\\repo\\web\\page.html',
    );
    expect(screen.getByTestId('text-lightbox').textContent).toBe(
      'page.html:C:\\repo\\web\\page.html',
    );
  });

  it('keeps left click routed to exact turn review', () => {
    render(<TurnChangesCard sessionId="session-1" changeSet={CHANGE_SET} />);

    fireEvent.click(screen.getByRole('button', { name: /src\/test\.ts/ }));

    expect(mocks.openTurnReview).toHaveBeenCalledWith(
      'session-1',
      ['change-1'],
      { selectedDiffId: 'file-1' },
    );
  });
});
