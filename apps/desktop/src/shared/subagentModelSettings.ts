/**
 * Cindy 托管的子代理模型覆盖。
 *
 * `null` 表示不指定，agent 必须保留其原生子代理模型选择逻辑。
 * Codex 字段先保留在稳定契约中；当前 Codex 二进制尚不能在完整上下文 fork 下安全覆盖模型。
 */
export interface SubagentModelSettings {
  claudeCode: string | null;
  codex: string | null;
}

export type SubagentModelSettingsPatch = Partial<SubagentModelSettings>;

export interface SubagentModelSettingsState extends SubagentModelSettings {
  isCustomized: boolean;
  customizedKeys: string[];
  defaults: SubagentModelSettings;
}

export const SUBAGENT_MODEL_SETTINGS_DEFAULTS: SubagentModelSettings = {
  claudeCode: null,
  codex: null,
};

export const MAX_SUBAGENT_MODEL_ID_LENGTH = 256;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

/** 磁盘读取的宽松归一化：非法值回退为“不指定”。 */
export function normalizeSubagentModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SUBAGENT_MODEL_ID_LENGTH) return null;
  if (containsControlCharacter(trimmed)) return null;
  return trimmed;
}

/** IPC 边界的严格校验；空字符串与 null 都表示“不指定”。 */
export function isValidSubagentModelIdInput(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return (
    trimmed.length <= MAX_SUBAGENT_MODEL_ID_LENGTH &&
    !containsControlCharacter(trimmed)
  );
}
