/**
 * 供应商推理路径的共享边界。
 *
 * 路径最终会原样进入 Node `http(s).request({ path })`，因此除同源约束外，还必须拒绝
 * Node 会以 `ERR_UNESCAPED_CHARACTERS` 同步抛出的字符；空格、控制符和非 Latin-1 字符
 * 应由用户先做 percent-encoding。
 */
export function isProviderRequestPath(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length >= 1
    && value.length <= 2_048
    && value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('#')
    && !value.includes('\\')
    && !/[^\u0021-\u00ff]/.test(value)
  );
}

/**
 * 把已验证的精确推理路径追加到 base URL，同时保留 base query。
 * requestPath 自带的 query 追加在 base query 后，fragment 一律不进入请求。
 */
export function appendProviderRequestPath(baseUrl: string, requestPath: string): string {
  if (!isProviderRequestPath(requestPath)) {
    throw new TypeError('invalid provider request path');
  }
  const url = new URL(baseUrl);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
  ) {
    throw new TypeError('invalid provider base URL');
  }
  const basePath = url.pathname.replace(/\/+$/, '');
  const queryIndex = requestPath.indexOf('?');
  const exactPath = queryIndex === -1 ? requestPath : requestPath.slice(0, queryIndex);
  const exactQuery = queryIndex === -1 ? '' : requestPath.slice(queryIndex + 1);
  const baseQuery = url.search.slice(1);
  url.pathname = `${basePath}${exactPath}`;
  url.search = [baseQuery, exactQuery].filter(Boolean).join('&');
  url.hash = '';
  return url.toString();
}
