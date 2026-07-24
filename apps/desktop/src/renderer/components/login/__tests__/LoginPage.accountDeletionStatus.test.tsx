// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loginHook = vi.hoisted(() => ({
  value: {
    isLoading: false,
    errorCode: null,
    loginState: { step: 'browser-redirect' as const, label: 'Google' },
    hasAccountDeletionReceipt: true,
    getAccountDeletionStatus: vi.fn(),
    clearAccountDeletionReceipt: vi.fn(),
    dispatch: vi.fn(),
    clearError: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: 'signed-out', enterLocalMode: vi.fn() }),
}));

vi.mock('@/hooks/useBrandLogo', () => ({
  useBrandLogo: () => 'brand-logo.svg',
}));

vi.mock('@/hooks/useLogin', () => ({
  useLogin: () => loginHook.value,
}));

vi.mock('@/components/title-bar/WindowControls', () => ({
  WindowControls: () => null,
}));

import { LoginPage } from '../LoginPage';

describe('LoginPage account deletion status', () => {
  beforeEach(() => {
    loginHook.value.hasAccountDeletionReceipt = true;
    loginHook.value.getAccountDeletionStatus = vi.fn().mockResolvedValue({
      success: true,
      value: {
        status: 'pending',
        requestedAt: '2026-07-22T00:00:00.000Z',
        deleteAfter: '2026-08-21T00:00:00.000Z',
      },
    });
    loginHook.value.clearAccountDeletionReceipt = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { platform: 'darwin' },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the pending grace-period state while keeping sign-in available', async () => {
    render(<LoginPage />);

    expect(await screen.findByText('accountDeletion.status.pendingTitle')).toBeTruthy();
    expect(screen.getByText('login.browserWaiting')).toBeTruthy();
    expect(loginHook.value.getAccountDeletionStatus).toHaveBeenCalledOnce();
  });

  it('lets the user dismiss a terminal completed receipt', async () => {
    loginHook.value.getAccountDeletionStatus.mockResolvedValue({
      success: true,
      value: {
        status: 'completed',
        requestedAt: '2026-07-22T00:00:00.000Z',
        deleteAfter: '2026-08-21T00:00:00.000Z',
        completedAt: '2026-08-21T00:05:00.000Z',
      },
    });
    render(<LoginPage />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'accountDeletion.status.dismissButton',
      }),
    );
    await waitFor(() => expect(loginHook.value.clearAccountDeletionReceipt).toHaveBeenCalledOnce());
    expect(screen.queryByText('accountDeletion.status.completedTitle')).toBeNull();
  });
});
