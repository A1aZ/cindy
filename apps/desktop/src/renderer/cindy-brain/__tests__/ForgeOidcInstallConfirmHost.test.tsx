// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { ForgeOidcInstallConfirmHost } from '../ForgeOidcInstallConfirmHost';

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { id?: string }) => (options?.id ? `${key}:${options.id}` : key),
  }),
}));

describe('ForgeOidcInstallConfirmHost', () => {
  let push:
    | ((payload: {
        requestId: string;
        ghostId: string;
        ghostName: string;
        hosts: string[];
      }) => void)
    | undefined;
  const resolveConfirm = vi.fn();

  beforeEach(() => {
    mocks.confirm.mockReset().mockResolvedValue(true);
    resolveConfirm.mockReset().mockResolvedValue({ handled: true });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      ghosts: {
        onForgeOidcInstallConfirmRequest: (callback: typeof push) => {
          push = callback;
          return () => {};
        },
        resolveForgeOidcInstallConfirm: resolveConfirm,
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('passes exact typed-id and selectable facts without adding a copy action', async () => {
    render(<ForgeOidcInstallConfirmHost />);
    await act(async () => {
      push?.({
        requestId: 'request-1',
        ghostId: 'acme-tool',
        ghostName: 'Acme Tool',
        hosts: ['api.acme.test', 'files.acme.test'],
      });
    });

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const options = mocks.confirm.mock.calls[0][0] as {
      content: ReactNode;
      contentSelectable: boolean;
      requireTypedConfirmation: { expected: string; label: string };
    };
    expect(options.contentSelectable).toBe(true);
    expect(options.requireTypedConfirmation).toEqual({
      expected: 'acme-tool',
      label: 'settings.ghosts.forgeOidcInstallConfirm.typedIdLabel:acme-tool',
    });

    render(<>{options.content}</>);
    expect(screen.getByText('Acme Tool')).toBeTruthy();
    expect(screen.getByText('acme-tool')).toBeTruthy();
    expect(screen.getByText('api.acme.test')).toBeTruthy();
    expect(screen.getByText('files.acme.test')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(resolveConfirm).toHaveBeenCalledWith('request-1', true);
  });
});
