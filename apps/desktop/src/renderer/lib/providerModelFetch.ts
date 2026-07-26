export type CustomProviderAuthMode = 'apiKey' | 'oauth' | 'none';

export interface ProviderModelFetchSignatureFields {
  baseUrl: string;
  requestPath: string;
  modelsUrl: string;
  apiKey: string;
  headers: ReadonlyArray<{ name: string; value: string }>;
}

export function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== 'authorization' && normalized !== 'x-api-key';
    }),
  );
}

/**
 * 模型发现请求的完整有效输入签名。只在当前对话框闭包内短暂比较，不持久化、不记录。
 * 鉴权模式变化会改变实际请求，即使表单里的 key/header 文本没有变化也必须作废旧响应。
 */
export function providerModelFetchRequestSignature(
  fields: ProviderModelFetchSignatureFields,
  authMode: CustomProviderAuthMode,
): string {
  const headers: Record<string, string> = {};
  for (const header of fields.headers) {
    const name = header.name.trim();
    if (name) headers[name] = header.value.trim();
  }
  const effectiveHeaders = authMode === 'none' ? stripCredentialHeaders(headers) : headers;
  return JSON.stringify({
    authMode,
    baseUrl: fields.baseUrl.trim(),
    requestPath: fields.requestPath.trim(),
    modelsUrl: fields.modelsUrl.trim(),
    apiKey: authMode === 'apiKey' ? fields.apiKey.trim() : null,
    headers: Object.entries(effectiveHeaders).sort(([a], [b]) => a.localeCompare(b)),
  });
}
