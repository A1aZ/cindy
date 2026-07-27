export interface PersistAndActivateSessionProviderInput {
  sessionId: string;
  providerId: string | null | undefined;
  updateProviderId: (sessionId: string, providerId: string | null) => Promise<void>;
  readProviderId: (sessionId: string) => Promise<string | null | undefined>;
  setSessionProvider: (sessionId: string, providerId: string | null) => void;
}

/**
 * create-session 后同步 provider route：显式 null 要落库覆盖旧来源，undefined 才表示不改库。
 *
 * 新引擎实例是生命周期边界，DB 中的 provider_id 是它的权威路由。这里必须覆盖同一
 * Cindy session 上一引擎留下的内存值；仅缺值才写入的 hydrate 语义只适合不打断 live
 * session 的普通恢复路径。
 */
export async function persistAndActivateSessionProvider(
  input: PersistAndActivateSessionProviderInput,
): Promise<void> {
  const createProviderId =
    typeof input.providerId === 'string' && input.providerId.trim()
      ? input.providerId.trim()
      : null;
  if (input.providerId !== undefined) {
    await input.updateProviderId(input.sessionId, createProviderId);
  }
  const persistedProviderId = await input.readProviderId(input.sessionId);
  input.setSessionProvider(input.sessionId, persistedProviderId ?? null);
}
