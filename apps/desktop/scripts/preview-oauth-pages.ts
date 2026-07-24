import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRAND_NAME } from '@cindy/maker-shared/branding';

import {
  buildOAuthReturnAction,
  getGhostOAuthResultCopy,
  getOAuthNeutralResultCopy,
  getProviderOAuthResultCopy,
  OAUTH_RESULT_HTML_LANG,
  renderOAuthResultPage,
  type OAuthResultPageInput,
  type OAuthResultPageLang,
  type OAuthResultPageTheme,
} from '../src/main/oauthResultPage.js';

const PAGE_KINDS = [
  'login-success',
  'login-error',
  'xai-success',
  'xai-error',
  'generic-success',
  'generic-error',
  'ghost-success',
  'ghost-error',
  'claude-error',
  'warning',
] as const;

type PageKind = (typeof PAGE_KINDS)[number];

/** Human-readable labels for the preview toolbar; callback copy lives below. */
const PAGE_LABELS: Record<PageKind, string> = {
  'login-success': 'Cindy 登录 · 成功',
  'login-error': 'Cindy 登录 · 失败',
  'xai-success': 'xAI · 成功',
  'xai-error': 'xAI · 失败',
  'generic-success': '通用模型供应商 · 成功',
  'generic-error': '通用模型供应商 · 失败',
  'ghost-success': '意识 OAuth · 成功',
  'ghost-error': '意识 OAuth · 失败',
  'claude-error': 'Claude · 本地失败页',
  warning: '需要继续操作 · 警告',
};

/**
 * Login callback copy comes from the SAME source production uses: renderer
 * locale JSONs' `login.browserCallback.*` (authManager resolves them via the
 * main mini-i18n; the preview cannot boot Electron, so it reads the JSON files
 * directly). Ghost / provider / neutral copy comes from the shared builders in
 * oauthResultPage.ts. No preview-only copy table remains — callback copy
 * builder 生产/preview 合一(PR0b-callback)。
 */
const LOCALE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/renderer/i18n/locales',
);

/**
 * Preview lang → renderer locale candidates(主干 4 语,中文全并进 zh-CN)。
 */
const OAUTH_LANG_TO_APP_LOCALES: Record<OAuthResultPageLang, string[]> = {
  zh: ['zh-CN'],
  en: ['en'],
  ja: ['ja'],
  ko: ['ko'],
};

interface LoginBrowserCallbackCopy {
  successTitle: string;
  successBody: string;
  errorTitle: string;
  errorBody: string;
  returnButton: string;
}

/** Reads production `login.browserCallback.*` copy, interpolating {{appName}}. */
function loadLoginCallbackCopy(lang: OAuthResultPageLang): LoginBrowserCallbackCopy {
  for (const locale of OAUTH_LANG_TO_APP_LOCALES[lang]) {
    const file = path.join(LOCALE_DIR, locale, 'common.json');
    if (!existsSync(file)) continue;
    const common = JSON.parse(readFileSync(file, 'utf8')) as {
      login?: { browserCallback?: Record<string, unknown> };
    };
    const raw = common.login?.browserCallback;
    if (!raw) continue;
    const resolve = (key: keyof LoginBrowserCallbackCopy): string => {
      const value = raw[key];
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`login.browserCallback.${key} missing in ${locale}/common.json`);
      }
      return value.replaceAll('{{appName}}', BRAND_NAME);
    };
    return {
      successTitle: resolve('successTitle'),
      successBody: resolve('successBody'),
      errorTitle: resolve('errorTitle'),
      errorBody: resolve('errorBody'),
      returnButton: resolve('returnButton'),
    };
  }
  throw new Error(`No locale file provides login.browserCallback for lang=${lang}`);
}

function isPageKind(value: string | null): value is PageKind {
  return PAGE_KINDS.includes(value as PageKind);
}

function isLang(value: string | null): value is OAuthResultPageLang {
  return value === 'zh' || value === 'en' || value === 'ja' || value === 'ko';
}

function isTheme(value: string | null): value is OAuthResultPageTheme {
  return value === 'light' || value === 'dark';
}

/** Builds one preview from the same renderer used by production callbacks. */
function renderPreviewPage(
  kind: PageKind,
  lang: OAuthResultPageLang,
  theme: OAuthResultPageTheme,
): string {
  const action = buildOAuthReturnAction(lang, `preview-${kind}`, BRAND_NAME);
  const base: Pick<OAuthResultPageInput, 'htmlLang' | 'theme' | 'action'> = {
    htmlLang: OAUTH_RESULT_HTML_LANG[lang],
    theme,
    action,
  };

  if (kind.startsWith('xai-') || kind.startsWith('generic-') || kind === 'claude-error') {
    const providerName = kind.startsWith('xai-')
      ? 'xAI'
      : kind === 'claude-error'
        ? 'Claude'
        : 'Acme AI';
    const provider = getProviderOAuthResultCopy(lang, providerName, BRAND_NAME);
    const success = kind.endsWith('-success');
    return renderOAuthResultPage({
      ...base,
      variant: success ? 'success' : 'error',
      title: success ? provider.successTitle : provider.errorTitle,
      body: success ? provider.successBody : provider.exchangeFailedBody,
      detail: success ? undefined : 'preview_error_code',
    });
  }

  if (kind === 'login-success' || kind === 'login-error') {
    const login = loadLoginCallbackCopy(lang);
    const success = kind === 'login-success';
    // 显式传 login pageKind(implementation-plan Step 4 WHAT1):preview 与生产
    // (authManager → renderAuthLoopbackPage)同走 wave4 新品牌卡。
    return renderOAuthResultPage({
      ...base,
      pageKind: 'desktop-login',
      copyKind: 'login.browserCallback',
      action: { ...action, label: login.returnButton },
      variant: success ? 'success' : 'error',
      title: success ? login.successTitle : login.errorTitle,
      body: success ? login.successBody : login.errorBody,
      detail: success ? undefined : 'STATE_MISMATCH',
    });
  }

  if (kind === 'ghost-success' || kind === 'ghost-error') {
    const ghost = getGhostOAuthResultCopy(lang);
    const success = kind === 'ghost-success';
    const body = (success ? ghost.successBody : ghost.errors['invalid-callback']).replaceAll(
      '{brand}',
      BRAND_NAME,
    );
    return renderOAuthResultPage({
      ...base,
      variant: success ? 'success' : 'error',
      title: success ? ghost.successTitle : ghost.errorTitle,
      body,
      detail: success ? undefined : 'access_denied',
    });
  }

  // 中性/warning 卡属登录卡族(demo CALLBACK.neutral 即三变体之一),preview 走
  // 新品牌卡以覆盖成功/失败/中性三变体 × 深浅色对照;生产暂无中性态调用方。
  const neutral = getOAuthNeutralResultCopy(lang, BRAND_NAME);
  return renderOAuthResultPage({
    ...base,
    pageKind: 'desktop-login',
    copyKind: 'callback.neutral',
    variant: 'warning',
    ...neutral,
  });
}

function renderToolbar(
  kind: PageKind,
  lang: OAuthResultPageLang,
  theme: OAuthResultPageTheme,
): string {
  const pageOptions = PAGE_KINDS.map(
    (value) =>
      `<option value="${value}"${value === kind ? ' selected' : ''}>${PAGE_LABELS[value]}</option>`,
  ).join('');
  const langOptions = (
    [
      ['zh', '简体中文'],
      ['en', 'English'],
      ['ja', '日本語'],
      ['ko', '한국어'],
    ] as const
  )
    .map(
      ([value, label]) =>
        `<option value="${value}"${value === lang ? ' selected' : ''}>${label}</option>`,
    )
    .join('');
  const themeOptions = (['light', 'dark'] as const)
    .map(
      (value) => `<option value="${value}"${value === theme ? ' selected' : ''}>${value}</option>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cindy OAuth 回调页预览</title>
<style>
*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;grid-template-rows:auto 1fr;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:#ececea;color:#262626}
.toolbar{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #d7d7d4;background:#f8f8f6}.title{font-size:14px;font-weight:600;margin-right:auto}.field{display:flex;align-items:center;gap:6px;font-size:12px;color:#737373}select,.open{height:34px;border:1px solid #c7c7c3;border-radius:8px;background:#fff;color:#262626;padding:0 10px;font:inherit}.open{display:inline-flex;align-items:center;text-decoration:none;font-size:12px}iframe{width:100%;height:100%;border:0;background:#f8f8f6}@media(max-width:720px){.toolbar{align-items:stretch;flex-wrap:wrap}.title{width:100%;margin:0}.field{flex:1;min-width:140px}.field select{width:100%}}
</style>
</head>
<body>
<div class="toolbar">
  <div class="title">Cindy OAuth 回调页 · 真实渲染器预览</div>
  <label class="field">页面<select id="kind">${pageOptions}</select></label>
  <label class="field">语言<select id="lang">${langOptions}</select></label>
  <label class="field">主题<select id="theme">${themeOptions}</select></label>
  <a class="open" id="open" target="_blank" rel="noreferrer">单独打开</a>
</div>
<iframe id="preview" title="OAuth result page preview"></iframe>
<script>
const fields={kind:document.querySelector('#kind'),lang:document.querySelector('#lang'),theme:document.querySelector('#theme')};
const frame=document.querySelector('#preview');const open=document.querySelector('#open');
function refresh(){const query=new URLSearchParams({kind:fields.kind.value,lang:fields.lang.value,theme:fields.theme.value});const page='/page?'+query;frame.src=page;open.href=page;history.replaceState(null,'','/?'+query)}
Object.values(fields).forEach((field)=>field.addEventListener('change',refresh));refresh();
</script>
</body>
</html>`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }

  const kind = isPageKind(url.searchParams.get('kind'))
    ? url.searchParams.get('kind')
    : 'login-success';
  const lang = isLang(url.searchParams.get('lang')) ? url.searchParams.get('lang') : 'zh';
  const theme = isTheme(url.searchParams.get('theme')) ? url.searchParams.get('theme') : 'light';
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.pathname === '/page') {
    response.end(renderPreviewPage(kind, lang, theme));
    return;
  }
  if (url.pathname === '/') {
    response.end(renderToolbar(kind, lang, theme));
    return;
  }
  response.writeHead(404).end('Not Found');
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (typeof address !== 'object' || address === null) return;
  process.stdout.write(`Cindy OAuth callback preview: http://127.0.0.1:${address.port}\n`);
});

process.once('SIGINT', () => server.close(() => process.exit(0)));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
