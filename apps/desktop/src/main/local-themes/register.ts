import { ipcMain } from 'electron';

import type { LocalThemeWriteRequest } from '../../shared/local-themes';
import { loadLocalThemes, loadLocalThemesSync } from './loader';
import { openLocalThemesDir, writeLocalTheme } from './writer';

export function registerLocalThemesIpc(): void {
  ipcMain.on('local-themes:list-sync', (event) => {
    event.returnValue = loadLocalThemesSync();
  });

  ipcMain.handle('local-themes:list', async () => loadLocalThemes());
  ipcMain.handle('local-themes:write', async (_event, req: LocalThemeWriteRequest) =>
    writeLocalTheme(req));
  ipcMain.handle('local-themes:open-dir', async () => openLocalThemesDir());
}
