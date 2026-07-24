// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LegacyMigrationDialog } from '../LegacyMigrationDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type LegacyMigrationPhase = 'confirm' | 'running' | 'done' | 'failed' | null;

function installLegacyMigrationApi(phase: LegacyMigrationPhase) {
  const api = {
    legacyMigration: {
      getState: vi.fn().mockResolvedValue({ phase }),
      onState: vi.fn().mockReturnValue(() => {}),
      confirm: vi.fn().mockResolvedValue(undefined),
    },
  };
  (window as unknown as { electronAPI: typeof api }).electronAPI = api;
  return api.legacyMigration;
}

describe('LegacyMigrationDialog states', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('legacy-confirm:确认态显示说明与唯一确认按钮', async () => {
    const api = installLegacyMigrationApi('confirm');
    render(<LegacyMigrationDialog />);

    expect(await screen.findByRole('dialog')).toBeTruthy();
    const button = await screen.findByRole('button', {
      name: 'legacyMigration.confirm',
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('legacyMigration.title')).toBeTruthy();
    expect(screen.getByText('legacyMigration.description')).toBeTruthy();
    expect(api.onState).toHaveBeenCalled();
  });

  it('legacy-running:运行态显示禁用 loading 按钮', async () => {
    installLegacyMigrationApi('running');
    render(<LegacyMigrationDialog />);

    expect(await screen.findByRole('dialog')).toBeTruthy();
    const button = await screen.findByRole('button', {
      name: /legacyMigration.migrating/,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('legacyMigration.description')).toBeNull();
  });

  it('legacy-failed:失败态使用回调卡样式和继续按钮', async () => {
    installLegacyMigrationApi('failed');
    render(<LegacyMigrationDialog />);

    expect(await screen.findByRole('dialog')).toBeTruthy();
    const button = await screen.findByRole('button', {
      name: 'legacyMigration.continue',
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('legacyMigration.failedTitle')).toBeTruthy();
    expect(screen.getByText('legacyMigration.failedDescription')).toBeTruthy();
  });
});
