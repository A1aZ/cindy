/**
 * sidebar 用户偏好(置顶手动顺序等)的 main 进程存储。
 * userData/sidebar-settings.json,跨 dev (http://localhost) / installed (file://) 共享,
 * 绕开 localStorage 按 origin 隔离的问题。
 */

import { ipcMain } from 'electron';
import Store from 'electron-store';

interface SidebarSettingsShape {
  pinnedOrder: string[];
}

let storeInstance: Store<SidebarSettingsShape> | null = null;

function getStore(): Store<SidebarSettingsShape> {
  if (!storeInstance) {
    storeInstance = new Store<SidebarSettingsShape>({
      name: 'sidebar-settings',
      defaults: { pinnedOrder: [] },
      schema: { pinnedOrder: { type: 'array', items: { type: 'string' } } },
      clearInvalidConfig: true,
    });
  }
  return storeInstance;
}

export function loadPinnedOrder(): string[] {
  return getStore().get('pinnedOrder', []);
}

export function savePinnedOrder(order: readonly string[]): void {
  getStore().set('pinnedOrder', Array.from(order));
}

export function registerSidebarSettingsIpc(): void {
  // sync read:让 renderer 的 useState(() => load()) 不用改成异步初始化
  ipcMain.on('sidebar-settings:load-pinned-order-sync', (event) => {
    event.returnValue = loadPinnedOrder();
  });
  ipcMain.handle('sidebar-settings:save-pinned-order', (_event, order: unknown) => {
    if (Array.isArray(order)) savePinnedOrder(order as string[]);
  });
}
