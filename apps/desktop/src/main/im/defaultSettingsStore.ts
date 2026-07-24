/**
 * IM 默认设置的 main 端持久化源。
 *
 * 文件只保存用户 override；系统默认值来自 shared/imDefaultSettings。这样未来默认模型
 * 升级时，未自定义用户会自动跟随新默认，已自定义用户保留自己的选择。
 */

import path from 'node:path';
import { app } from 'electron';

import {
  IM_DEFAULT_SETTINGS,
  type ImDefaultAgentKind,
  type ImDefaultAgentSettings,
  type ImDefaultSettingsPatch,
  type ImDefaultSettings,
  isImDefaultAgentKind,
  isImDefaultEffort,
} from '../../shared/imDefaultSettings.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from '../maker-host/override-settings-file.js';
import { claimLegacyImPath, ownerScopedImUserDataPath } from './ownerScopedStorage.js';

const log = desktopMakerLogger.child('im-default-settings-store');

function settingsFilePath(): string {
  const scoped = ownerScopedImUserDataPath('im-default-settings.json');
  claimLegacyImPath(path.join(app.getPath('userData'), 'im-default-settings.json'), scoped);
  return scoped;
}

function normalize(raw: unknown): ImDefaultSettings {
  if (!raw || typeof raw !== 'object') return { ...IM_DEFAULT_SETTINGS };
  const r = raw as Record<string, unknown>;
  const agentKind = isImDefaultAgentKind(r.agentKind) ? r.agentKind : IM_DEFAULT_SETTINGS.agentKind;
  const rawAgents = isRecord(r.agents) ? r.agents : {};
  const legacySettings = legacyAgentSettings(r);
  return {
    agentKind,
    agents: {
      'claude-code': normalizeAgentSettings(
        'claude-code',
        rawAgentOrLegacy(rawAgents, 'claude-code', agentKind, legacySettings),
      ),
      codex: normalizeAgentSettings(
        'codex',
        rawAgentOrLegacy(rawAgents, 'codex', agentKind, legacySettings),
      ),
    },
  };
}

function rawAgentOrLegacy(
  rawAgents: Record<string, unknown>,
  target: ImDefaultAgentKind,
  selected: ImDefaultAgentKind,
  legacySettings: Partial<ImDefaultAgentSettings> | null,
): unknown {
  const raw = rawAgents[target];
  if (target !== selected || !legacySettings) return raw ?? null;
  if (!isRecord(raw)) return legacySettings;
  return agentSettingsMatchesDefaults(target, raw) ? legacySettings : raw;
}

function agentSettingsMatchesDefaults(
  agentKind: ImDefaultAgentKind,
  raw: Record<string, unknown>,
): boolean {
  const normalized = normalizeAgentSettings(agentKind, raw);
  return JSON.stringify(normalized) === JSON.stringify(IM_DEFAULT_SETTINGS.agents[agentKind]);
}

function normalizeAgentSettings(
  agentKind: ImDefaultAgentKind,
  raw: unknown,
): ImDefaultAgentSettings {
  const defaults = IM_DEFAULT_SETTINGS.agents[agentKind];
  if (!isRecord(raw)) return { ...defaults };
  return {
    providerId:
      typeof raw.providerId === 'string' && raw.providerId.trim() ? raw.providerId.trim() : null,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : defaults.model,
    effort: isImDefaultEffort(raw.effort) ? raw.effort : defaults.effort,
  };
}

function legacyAgentSettings(raw: Record<string, unknown>): Partial<ImDefaultAgentSettings> | null {
  if (!('providerId' in raw) && !('model' in raw) && !('effort' in raw)) return null;
  return {
    providerId:
      typeof raw.providerId === 'string' && raw.providerId.trim() ? raw.providerId.trim() : null,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
    effort: isImDefaultEffort(raw.effort) ? raw.effort : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const store = createOverrideSettingsFile<ImDefaultSettings>({
  filePath: settingsFilePath,
  defaults: IM_DEFAULT_SETTINGS,
  normalize,
  mergeOverrides: mergeImDefaultOverrides,
  log,
  label: 'im-default',
});

export function readImDefaultSettings(): ImDefaultSettings {
  return store.read();
}

export function readImDefaultSettingsState(): OverrideSettingsState<ImDefaultSettings> {
  return store.readState();
}

export function writeImDefaultSettingsPatch(
  patch: ImDefaultSettingsPatch,
): OverrideSettingsState<ImDefaultSettings> {
  store.writePatch(patch as Partial<ImDefaultSettings>);
  log.info('im default settings written', patch);
  return store.readState();
}

export function resetImDefaultSettings(): ImDefaultSettings {
  return store.reset();
}

export const __testing = { normalize };

function mergeImDefaultOverrides(args: {
  patch: Partial<ImDefaultSettings>;
  next: ImDefaultSettings;
  defaults: ImDefaultSettings;
  overrides: Record<string, unknown>;
}): Record<string, unknown> {
  const nextOverrides = { ...args.overrides };
  if ('agentKind' in args.patch) {
    if (args.next.agentKind === args.defaults.agentKind) {
      delete nextOverrides.agentKind;
    } else {
      nextOverrides.agentKind = args.next.agentKind;
    }
  }
  if ('agents' in args.patch) {
    const patchAgents = isRecord(args.patch.agents) ? args.patch.agents : {};
    const agentOverrides = isRecord(nextOverrides.agents) ? { ...nextOverrides.agents } : {};
    for (const agentKind of Object.keys(patchAgents)) {
      if (!isImDefaultAgentKind(agentKind)) continue;
      const normalized = args.next.agents[agentKind];
      if (agentSettingsEqual(normalized, args.defaults.agents[agentKind])) {
        delete agentOverrides[agentKind];
      } else {
        agentOverrides[agentKind] = normalized;
      }
    }
    if (Object.keys(agentOverrides).length > 0) {
      nextOverrides.agents = agentOverrides;
    } else {
      delete nextOverrides.agents;
    }
  }
  return nextOverrides;
}

function agentSettingsEqual(a: ImDefaultAgentSettings, b: ImDefaultAgentSettings): boolean {
  return a.providerId === b.providerId && a.model === b.model && a.effort === b.effort;
}
