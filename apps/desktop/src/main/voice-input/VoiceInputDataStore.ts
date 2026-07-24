import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import type { DictationDictionaryLearningAction } from '@cindy/voice-input-core';

import { createLogger } from '../logger.js';
import { ownerScopedUserDataPath, getActiveAppSession } from '../appSessionState.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  applyVoiceInputDictionaryLearningActions,
  compactVoiceInputHistoryIfNeeded,
  createVoiceInputHistoryEntry,
  deleteVoiceInputDictionaryEntriesFromSettings,
  getDefaultVoiceInputSettings,
  getNewAutomaticDictionaryEntries,
  normalizeVoiceInputDataSnapshot,
  normalizeVoiceInputHistory,
  normalizeVoiceInputSettings,
  type VoiceInputDataSnapshot,
  type VoiceInputDictionaryEntry,
  type VoiceInputHistoryEntry,
  type VoiceInputSettings,
  type VoiceInputSyncErrorResult,
} from '../../shared/voiceInputData.js';

const log = createLogger('voice-input:data-store');
const DATA_FILE_NAME = 'voice-input-data.v1.json';
let ipcRegistered = false;

type StoredVoiceInputData = VoiceInputDataSnapshot & {
  version: 1;
  legacyRendererStorageMigrated?: boolean;
};

type LegacyRendererDataPayload = {
  settingsRaw?: string | null;
  historyRaw?: string | null;
};

type DataChangedPayload = {
  settings: VoiceInputSettings;
  history: VoiceInputHistoryEntry[];
};

export class VoiceInputDataStore {
  private state: StoredVoiceInputData | null = null;
  private stateOwnerId: string | null = null;

  getSnapshot(): VoiceInputDataSnapshot {
    return cloneSnapshot(this.load());
  }

  getSettings(): VoiceInputSettings {
    return this.getSnapshot().settings;
  }

  getHistory(limit?: number): VoiceInputHistoryEntry[] {
    const history = this.load().history;
    return cloneHistory(typeof limit === 'number' ? history.slice(0, Math.max(0, limit)) : history);
  }

  getHistoryForRefinement(): VoiceInputHistoryEntry[] {
    const current = this.load();
    const compacted = compactVoiceInputHistoryIfNeeded(current.history);
    if (compacted !== current.history) {
      this.replaceState({
        ...current,
        history: compacted,
      });
    }
    return cloneHistory(compacted);
  }

  updateSettings(patch: unknown): VoiceInputSettings {
    const current = this.load();
    const nextSettings = normalizeVoiceInputSettings({
      ...current.settings,
      ...(isRecord(patch) ? patch : {}),
    }, process.platform);
    this.replaceState({
      ...current,
      settings: nextSettings,
    });
    return cloneSettings(nextSettings);
  }

  deleteDictionaryEntries(entryIds: string[]): VoiceInputSettings {
    const current = this.load();
    const nextSettings = deleteVoiceInputDictionaryEntriesFromSettings(current.settings, entryIds);
    if (nextSettings !== current.settings) {
      this.replaceState({
        ...current,
        settings: nextSettings,
      });
    }
    return cloneSettings(nextSettings);
  }

  recordDictionaryLearningActions(actions: DictationDictionaryLearningAction[]): {
    settings: VoiceInputSettings;
    newAutomaticEntries: Array<Pick<VoiceInputDictionaryEntry, 'id' | 'text'>>;
  } {
    const current = this.load();
    const appliedSettings = applyVoiceInputDictionaryLearningActions(current.settings, actions);
    if (appliedSettings === current.settings) {
      return { settings: cloneSettings(current.settings), newAutomaticEntries: [] };
    }
    const nextSettings = normalizeVoiceInputSettings(appliedSettings, process.platform);
    const newAutomaticEntries = getNewAutomaticDictionaryEntries(
      current.settings.dictionaryEntries,
      nextSettings.dictionaryEntries,
    );
    this.replaceState({
      ...current,
      settings: nextSettings,
    });
    return {
      settings: cloneSettings(nextSettings),
      newAutomaticEntries,
    };
  }

  recordHistory(text: string): string | null {
    const normalizedText = text.trim();
    if (!normalizedText) return null;
    const current = this.load();
    const duplicate = current.history.find((entry) => entry.text === normalizedText);
    if (duplicate) return duplicate.id;
    const entry = createVoiceInputHistoryEntry(normalizedText);
    if (!entry) return null;
    const history = compactVoiceInputHistoryIfNeeded([entry, ...current.history]);
    this.replaceState({
      ...current,
      history,
    });
    return entry.id;
  }

  updateHistoryEntry(id: string, text: string): void {
    const normalizedText = text.trim();
    if (!id || !normalizedText) return;
    const current = this.load();
    const entry = current.history.find((candidate) => candidate.id === id);
    if (!entry) return;
    this.replaceState({
      ...current,
      history: normalizeVoiceInputHistory([
        {
          ...entry,
          text: normalizedText,
        },
        ...current.history.filter((candidate) => candidate.id !== id),
      ]),
    });
  }

  deleteHistoryEntry(id: string): void {
    const current = this.load();
    const history = current.history.filter((entry) => entry.id !== id);
    if (history.length === current.history.length) return;
    this.replaceState({
      ...current,
      history,
    });
  }

  migrateLegacyRendererStorage(payload: LegacyRendererDataPayload | undefined): VoiceInputDataSnapshot {
    const current = this.load();
    if (current.legacyRendererStorageMigrated) return this.getSnapshot();
    let settings = current.settings;
    let history = current.history;

    if (payload?.settingsRaw) {
      try {
        settings = normalizeVoiceInputSettings(JSON.parse(payload.settingsRaw), process.platform);
      } catch (error) {
        log.warn('legacy renderer voice-input settings migration failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (payload?.historyRaw) {
      try {
        history = normalizeVoiceInputHistory(JSON.parse(payload.historyRaw));
      } catch (error) {
        log.warn('legacy renderer voice-input history migration failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.replaceState({
      ...current,
      legacyRendererStorageMigrated: true,
      settings,
      history: compactVoiceInputHistoryIfNeeded(history),
    });
    return this.getSnapshot();
  }

  private load(): StoredVoiceInputData {
    const ownerId = getActiveAppSession().dataOwnerId;
    if (this.state && this.stateOwnerId !== ownerId) this.state = null;
    this.stateOwnerId = ownerId;
    if (this.state) return this.state;
    const filePath = getDataFilePath();
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const snapshot = normalizeVoiceInputDataSnapshot(parsed, process.platform);
      this.state = {
        version: 1,
        legacyRendererStorageMigrated: isRecord(parsed) && parsed.legacyRendererStorageMigrated === true,
        ...snapshot,
      };
      return this.state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('voice input data read failed, using defaults', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.state = {
        version: 1,
        settings: getDefaultVoiceInputSettings(process.platform),
        history: [],
      };
      return this.state;
    }
  }

  private replaceState(next: StoredVoiceInputData): void {
    const normalizedState: StoredVoiceInputData = {
      version: 1,
      legacyRendererStorageMigrated: next.legacyRendererStorageMigrated,
      settings: normalizeVoiceInputSettings(next.settings, process.platform),
      history: compactVoiceInputHistoryIfNeeded(normalizeVoiceInputHistory(next.history)),
    };
    // 只有文件替换成功后才能提交内存状态和广播，避免 UI 显示未持久化的数据。
    this.save(normalizedState);
    this.state = normalizedState;
    broadcastVoiceInputDataChanged({
      settings: normalizedState.settings,
      history: normalizedState.history,
    });
  }

  private save(state: StoredVoiceInputData): void {
    const filePath = getDataFilePath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch (error) {
      log.warn('voice input data write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new VoiceInputDataStoreWriteError(error);
    }
  }
}

/** 语音数据写盘失败，供 IPC 层转换为标准 INTERNAL 错误。 */
export class VoiceInputDataStoreWriteError extends Error {
  constructor(cause: unknown) {
    super(`voice input data write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'VoiceInputDataStoreWriteError';
  }
}

export const voiceInputDataStore = new VoiceInputDataStore();

export function registerVoiceInputDataStoreIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on('voice-input:data:get', (event) => {
    event.returnValue = voiceInputDataStore.getSnapshot();
  });

  ipcMain.on('voice-input:data:migrate-legacy', (event, payload: LegacyRendererDataPayload | undefined) => {
    try {
      event.returnValue = voiceInputDataStore.migrateLegacyRendererStorage(payload);
    } catch (error) {
      event.returnValue = voiceInputDataStoreIpcErrorResult(error);
    }
  });

  ipcMain.handle('voice-input:settings:update', (_event, patch: unknown): VoiceInputSettings => {
    try {
      return voiceInputDataStore.updateSettings(patch);
    } catch (error) {
      throwVoiceInputDataStoreIpcError(error);
    }
  });

  ipcMain.handle('voice-input:dictionary:delete-entries', (_event, entryIds: string[]): VoiceInputSettings => {
    try {
      return voiceInputDataStore.deleteDictionaryEntries(entryIds);
    } catch (error) {
      throwVoiceInputDataStoreIpcError(error);
    }
  });

  ipcMain.handle('voice-input:dictionary-learning:record-actions', (_event, actions: DictationDictionaryLearningAction[]) => {
    try {
      return voiceInputDataStore.recordDictionaryLearningActions(actions);
    } catch (error) {
      throwVoiceInputDataStoreIpcError(error);
    }
  });

  ipcMain.on('voice-input:history:get', (event, limit?: number) => {
    event.returnValue = voiceInputDataStore.getHistory(limit);
  });

  ipcMain.on('voice-input:history:get-for-refinement', (event) => {
    try {
      event.returnValue = voiceInputDataStore.getHistoryForRefinement();
    } catch (error) {
      event.returnValue = voiceInputDataStoreIpcErrorResult(error);
    }
  });

  ipcMain.on('voice-input:history:record', (event, text: string) => {
    try {
      event.returnValue = voiceInputDataStore.recordHistory(text);
    } catch (error) {
      event.returnValue = voiceInputDataStoreIpcErrorResult(error);
    }
  });

  ipcMain.on('voice-input:history:update', (event, payload: { id?: string; text?: string }) => {
    try {
      if (typeof payload?.id === 'string' && typeof payload.text === 'string') {
        voiceInputDataStore.updateHistoryEntry(payload.id, payload.text);
      }
      // Every ipcRenderer.sendSync caller must receive a value. Leaving the
      // success path unset blocks the renderer forever after refinement.
      event.returnValue = true;
    } catch (error) {
      event.returnValue = voiceInputDataStoreIpcErrorResult(error);
    }
  });

  ipcMain.on('voice-input:history:delete', (event, id: string) => {
    try {
      if (typeof id === 'string') {
        voiceInputDataStore.deleteHistoryEntry(id);
      }
      event.returnValue = true;
    } catch (error) {
      event.returnValue = voiceInputDataStoreIpcErrorResult(error);
    }
  });
}

function throwVoiceInputDataStoreIpcError(error: unknown): never {
  if (error instanceof VoiceInputDataStoreWriteError) {
    throwIpcError('INTERNAL', error.message);
  }
  throw error;
}

function voiceInputDataStoreIpcErrorResult(error: unknown): VoiceInputSyncErrorResult {
  if (error instanceof VoiceInputDataStoreWriteError) {
    return { ok: false, code: 'INTERNAL', message: error.message };
  }
  throw error;
}

function getDataFilePath(): string {
  // Keep the pre-auth bootstrap path compatible with legacy installs. Once a
  // stable owner exists (including local-v1), all voice data is owner-scoped.
  const ownerId = getActiveAppSession().dataOwnerId;
  return ownerId ? ownerScopedUserDataPath(DATA_FILE_NAME) : path.join(app.getPath('userData'), DATA_FILE_NAME);
}

function broadcastVoiceInputDataChanged(payload: DataChangedPayload): void {
  const snapshot = cloneSnapshot(payload);
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send('voice-input:data-changed', snapshot);
  });
}

function cloneSnapshot(snapshot: VoiceInputDataSnapshot): VoiceInputDataSnapshot {
  return {
    settings: cloneSettings(snapshot.settings),
    history: cloneHistory(snapshot.history),
  };
}

function cloneSettings(settings: VoiceInputSettings): VoiceInputSettings {
  return JSON.parse(JSON.stringify(settings)) as VoiceInputSettings;
}

function cloneHistory(history: VoiceInputHistoryEntry[]): VoiceInputHistoryEntry[] {
  return JSON.parse(JSON.stringify(history)) as VoiceInputHistoryEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
