import { describe, expect, it } from 'vitest';

import {
  applyHtmlResourceUrls,
  htmlResourceMimeFor,
  collectHtmlLocalResourceRefs,
  htmlBaseDirOf,
  maskInertHtmlText,
  HTML_RESOURCE_LIMIT,
  planHtmlResourceFetches,
  resolveHtmlResourcePath,
  HTML_RESOURCE_TOTAL_MAX_CHARS,
} from '@/session/htmlLocalResources';
import { fetchHtmlResourceUrls } from '@/session/useHtmlLocalResources';

const BASE = '/Users/me/drafts';

/** 取件目标简写(取件编排只关心 absPath + mimeType)。 */
const t = (absPath: string) => ({ absPath, mimeType: 'image/png' });

describe('resolveHtmlResourcePath(引用 → 被控端绝对路径)', () => {
  it('相对引用按 HTML 所在目录换算', () => {
    expect(resolveHtmlResourcePath(BASE, 'chart.png')).toBe('/Users/me/drafts/chart.png');
    expect(resolveHtmlResourcePath(BASE, './chart.png')).toBe('/Users/me/drafts/chart.png');
    expect(resolveHtmlResourcePath(BASE, 'assets/app.css')).toBe('/Users/me/drafts/assets/app.css');
    expect(resolveHtmlResourcePath(BASE, 'a//b/./c.js')).toBe('/Users/me/drafts/a/b/c.js');
  });

  it('尾分隔符的 baseDir 不产生双斜杠', () => {
    expect(resolveHtmlResourcePath('/Users/me/drafts/', 'x.png')).toBe('/Users/me/drafts/x.png');
  });

  it('查询串与片段剥掉(改写会替掉整个引用,丢掉它们无副作用)', () => {
    expect(resolveHtmlResourcePath(BASE, 'app.css?v=2')).toBe('/Users/me/drafts/app.css');
    expect(resolveHtmlResourcePath(BASE, 'icons.svg#logo')).toBe('/Users/me/drafts/icons.svg');
  });

  it('百分号编码还原成真实文件名;非法序列不 throw', () => {
    expect(resolveHtmlResourcePath(BASE, 'my%20chart.png')).toBe('/Users/me/drafts/my chart.png');
    expect(resolveHtmlResourcePath(BASE, '50%off.png')).toBe('/Users/me/drafts/50%off.png');
  });

  it('Windows 被控端按反斜杠 join', () => {
    expect(resolveHtmlResourcePath('C:\\proj\\drafts', 'assets/x.png'))
      .toBe('C:\\proj\\drafts\\assets\\x.png');
  });

  it('中文目录名照常', () => {
    expect(resolveHtmlResourcePath(BASE, '设计稿/图 1.png'))
      .toBe('/Users/me/drafts/设计稿/图 1.png');
  });

  // ── fail-closed:以下一律不改写,保持原引用 ──

  it('含 `..` 段一律拒绝(逃出 HTML 所在目录子树)', () => {
    expect(resolveHtmlResourcePath(BASE, '../shared/x.png')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, 'assets/../../x.png')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, '..')).toBeNull();
  });

  it('根相对与本机绝对拒绝(前者语义是 web root,后者是最该警惕的形态)', () => {
    expect(resolveHtmlResourcePath(BASE, '/assets/x.png')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, '/etc/passwd')).toBeNull();
    expect(resolveHtmlResourcePath('C:\\proj', 'D:\\other\\x.png')).toBeNull();
  });

  it('带 scheme 与协议相对拒绝(本来就能加载,或本来就不该加载)', () => {
    expect(resolveHtmlResourcePath(BASE, 'https://cdn.example.com/x.png')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, 'http://localhost:5173/x.js')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, 'data:image/png;base64,AAAA')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, 'file:///Users/me/x.png')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, '//cdn.example.com/x.png')).toBeNull();
  });

  it('纯锚点 / 空 / 无 baseDir 拒绝', () => {
    expect(resolveHtmlResourcePath(BASE, '#top')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, '   ')).toBeNull();
    expect(resolveHtmlResourcePath('', 'x.png')).toBeNull();
  });
});

describe('htmlBaseDirOf', () => {
  it('取父目录,保住根形态', () => {
    expect(htmlBaseDirOf('/Users/me/drafts/a.html')).toBe('/Users/me/drafts');
    expect(htmlBaseDirOf('/a.html')).toBe('/');
    expect(htmlBaseDirOf('C:\\proj\\a.html')).toBe('C:\\proj');
    expect(htmlBaseDirOf('a.html')).toBe('');
  });
});

describe('collectHtmlLocalResourceRefs(词法定位)', () => {
  const values = (html: string): string[] =>
    collectHtmlLocalResourceRefs(html, BASE).map((ref) => ref.raw);

  it('收白名单标签上的资源属性', () => {
    const html = [
      '<link rel="stylesheet" href="assets/app.css">',
      '<script src="./app.js"></script>',
      '<img src="chart.png" alt="图">',
      '<video src="clip.mp4" poster="cover.jpg"></video>',
      '<source src=\'audio.mp3\'>',
    ].join('\n');
    // 音视频**刻意不在 MIME 表里**:资源要整份内联成 data: URI,一段视频足以撑爆内存。
    // 它们保持原引用(渲染成不可播放的占位),poster 图这类静态图仍照常内联。
    expect(values(html)).toEqual([
      'assets/app.css', './app.js', 'chart.png', 'cover.jpg',
    ]);
  });

  it('不在白名单的标签 / 属性不碰', () => {
    // `<a href>` 是导航不是资源;`data-src` 不是资源属性。
    expect(values('<a href="other.html">x</a>')).toEqual([]);
    expect(values('<div data-src="x.png"></div>')).toEqual([]);
    // 标签名必须恰好匹配:img-wrapper 不是 img。
    expect(values('<img-wrapper src="x.png"></img-wrapper>')).toEqual([]);
  });

  it('无引号属性值也收', () => {
    expect(values('<img src=chart.png>')).toEqual(['chart.png']);
  });

  it('http(s) / data: 引用不收(它们本来就能加载)', () => {
    expect(values('<img src="https://cdn.example.com/a.png"><img src="data:image/png;base64,AA">'))
      .toEqual([]);
  });

  it('<style> 块里的 url() 收(同一份文档里的内联样式)', () => {
    const html = '<style>body{background:url("bg.png")} .a{mask:url(m.svg)}</style>';
    expect(values(html)).toEqual(['bg.png', 'm.svg']);
  });

  it('空文档 / 无 baseDir 返回空', () => {
    expect(collectHtmlLocalResourceRefs('', BASE)).toEqual([]);
    expect(collectHtmlLocalResourceRefs('<img src="a.png">', '')).toEqual([]);
  });

  it('区间精确指向属性值本身(不含引号)', () => {
    const html = '<img src="chart.png">';
    const [ref] = collectHtmlLocalResourceRefs(html, BASE);
    expect(html.slice(ref.start, ref.end)).toBe('chart.png');
    expect(ref.absPath).toBe('/Users/me/drafts/chart.png');
  });

  it('多处引用按位置升序(回填从后往前才安全)', () => {
    const refs = collectHtmlLocalResourceRefs(
      '<style>.a{background:url(bg.png)}</style><img src="chart.png">',
      BASE,
    );
    expect(refs.map((r) => r.raw)).toEqual(['bg.png', 'chart.png']);
    expect(refs[0].start).toBeLessThan(refs[1].start);
  });
});

describe('applyHtmlResourceUrls(回填)', () => {
  it('多处引用整体替换,区间不串位', () => {
    const html = '<link href="a.css"><img src="b.png"><script src="c.js"></script>';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    const urls = new Map([
      ['/Users/me/drafts/a.css', 'https://oss/a'],
      ['/Users/me/drafts/b.png', 'https://oss/b'],
      ['/Users/me/drafts/c.js', 'https://oss/c'],
    ]);
    expect(applyHtmlResourceUrls(html, refs, urls)).toBe(
      '<link href="https://oss/a"><img src="https://oss/b"><script src="https://oss/c"></script>',
    );
  });

  it('取不到的保留原引用(渲染成破图比换成错地址诚实)', () => {
    const html = '<img src="a.png"><img src="b.png">';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    const urls = new Map([['/Users/me/drafts/b.png', 'https://oss/b']]);
    expect(applyHtmlResourceUrls(html, refs, urls)).toBe(
      '<img src="a.png"><img src="https://oss/b">',
    );
  });

  it('同一路径多处引用共用一个取回地址', () => {
    const html = '<img src="a.png"><img src="./a.png">';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    const urls = new Map([['/Users/me/drafts/a.png', 'https://oss/a']]);
    expect(applyHtmlResourceUrls(html, refs, urls)).toBe(
      '<img src="https://oss/a"><img src="https://oss/a">',
    );
  });

  it('style 块与属性混排也不串位', () => {
    const html = '<style>.a{background:url(bg.png)}</style><img src="chart.png">';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    const urls = new Map([
      ['/Users/me/drafts/bg.png', 'https://oss/bg'],
      ['/Users/me/drafts/chart.png', 'https://oss/chart'],
    ]);
    expect(applyHtmlResourceUrls(html, refs, urls)).toBe(
      '<style>.a{background:url(https://oss/bg)}</style><img src="https://oss/chart">',
    );
  });
});

describe('planHtmlResourceFetches(去重与上限)', () => {
  it('按首次出现顺序去重', () => {
    const refs = collectHtmlLocalResourceRefs(
      '<img src="b.png"><img src="a.png"><img src="./b.png">',
      BASE,
    );
    expect(planHtmlResourceFetches(refs)).toEqual({
      targets: [
        { absPath: '/Users/me/drafts/b.png', mimeType: 'image/png' },
        { absPath: '/Users/me/drafts/a.png', mimeType: 'image/png' },
      ],
      skipped: 0,
    });
  });

  it('超上限的计入 skipped,不静默截断', () => {
    const html = Array.from({ length: HTML_RESOURCE_LIMIT + 3 }, (_, i) => `<img src="a${i}.png">`).join('');
    const plan = planHtmlResourceFetches(collectHtmlLocalResourceRefs(html, BASE));
    expect(plan.targets).toHaveLength(HTML_RESOURCE_LIMIT);
    expect(plan.skipped).toBe(3);
  });

  it('自包含页面 → 零待取(零请求路径)', () => {
    const html = '<style>body{color:red}</style><img src="data:image/png;base64,AA">';
    expect(planHtmlResourceFetches(collectHtmlLocalResourceRefs(html, BASE)).targets).toEqual([]);
  });
});

describe('fetchHtmlResourceUrls(限并发批量取件)', () => {
  it('全部成功:地址齐全,失败数为 0', async () => {
    const out = await fetchHtmlResourceUrls(
      [t('/a.png'), t('/b.png')],
      async ({ absPath }) => `data:image/png;base64,${absPath}`,
    );
    expect(out.failed).toBe(0);
    expect([...out.urlByAbsPath]).toEqual([
      ['/a.png', 'data:image/png;base64,/a.png'],
      ['/b.png', 'data:image/png;base64,/b.png'],
    ]);
  });

  it('单个失败不影响其它(整页不因一张图取不到而失败)', async () => {
    const out = await fetchHtmlResourceUrls(
      [t('/a.png'), t('/bad.png'), t('/c.png')],
      async ({ absPath }) => {
        if (absPath === '/bad.png') throw new Error('nope');
        return `data:image/png;base64,${absPath}`;
      },
    );
    expect(out.failed).toBe(1);
    expect(out.urlByAbsPath.has('/bad.png')).toBe(false);
    expect(out.urlByAbsPath.size).toBe(2);
  });

  it('回空地址也算失败(不把空串回填进 HTML)', async () => {
    const out = await fetchHtmlResourceUrls([t('/a.png')], async () => '');
    expect(out.failed).toBe(1);
    expect(out.urlByAbsPath.size).toBe(0);
  });

  it('并发不超过上限,且每个路径只取一次', async () => {
    let inFlight = 0;
    let peak = 0;
    const calls: string[] = [];
    const paths = Array.from({ length: 9 }, (_, i) => t(`/a${i}.png`));
    const out = await fetchHtmlResourceUrls(
      paths,
      async ({ absPath }) => {
        calls.push(absPath);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return `data:image/png;base64,${absPath}`;
      },
      { concurrency: 3 },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(calls).toHaveLength(9);
    expect(new Set(calls).size).toBe(9);
    expect(out.urlByAbsPath.size).toBe(9);
  });

  it('已取消时停止后续取件(卸载 / 换文档后不白发请求)', async () => {
    const calls: string[] = [];
    let cancelled = false;
    const out = await fetchHtmlResourceUrls(
      Array.from({ length: 8 }, (_, i) => t(`/a${i}.png`)),
      async ({ absPath }) => {
        calls.push(absPath);
        cancelled = true; // 第一批发出后即取消
        return `data:image/png;base64,${absPath}`;
      },
      { concurrency: 1, isCancelled: () => cancelled },
    );
    expect(calls).toEqual(['/a0.png']);
    expect(out.urlByAbsPath.size).toBe(1);
  });

  it('空清单不发请求', async () => {
    let called = false;
    const out = await fetchHtmlResourceUrls([], async () => {
      called = true;
      return 'x';
    });
    expect(called).toBe(false);
    expect(out).toEqual({ urlByAbsPath: new Map(), failed: 0, overBudget: 0 });
  });
});

describe('htmlResourceMimeFor(data: URI 的类型)', () => {
  it('常见 web 资源给准类型', () => {
    expect(htmlResourceMimeFor('a/app.css')).toBe('text/css');
    expect(htmlResourceMimeFor('a/app.js')).toBe('text/javascript');
    expect(htmlResourceMimeFor('a/logo.SVG')).toBe('image/svg+xml');
    expect(htmlResourceMimeFor('a/x.png?v=2')).toBe('image/png');
    expect(htmlResourceMimeFor('a/f.woff2')).toBe('font/woff2');
  });

  it('表外类型不猜 —— 猜错会让浏览器拒收样式表/脚本,静默失效', () => {
    expect(htmlResourceMimeFor('a/data.bin')).toBeNull();
    expect(htmlResourceMimeFor('a/archive.zip')).toBeNull();
    expect(htmlResourceMimeFor('noext')).toBeNull();
  });
});

describe('MIME 未知的引用不进候选(fail-closed)', () => {
  it('未知类型不改写,保持原引用', () => {
    const refs = collectHtmlLocalResourceRefs('<img src="a.png"><embed src="x.bin">', BASE);
    expect(refs.map((r) => r.raw)).toEqual(['a.png']);
    expect(refs[0].mimeType).toBe('image/png');
  });
});

describe('SVG fragment 必须保留(sprite 靠它选 symbol)', () => {
  it('属性与 url() 两种形态都把 fragment 补回 data: URI 之后', () => {
    const html = '<img src="icons.svg#logo"><style>.a{background:url(sprite.svg#download)}</style>';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    expect(refs.map((r) => r.fragment)).toEqual(['#logo', '#download']);
    // 取件按无 fragment 的路径走(同一个文件只取一次)。
    expect(refs[0].absPath).toBe('/Users/me/drafts/icons.svg');
    expect(refs[1].absPath).toBe('/Users/me/drafts/sprite.svg');
    const urls = new Map([
      ['/Users/me/drafts/icons.svg', 'data:image/svg+xml;base64,AAA'],
      ['/Users/me/drafts/sprite.svg', 'data:image/svg+xml;base64,BBB'],
    ]);
    expect(applyHtmlResourceUrls(html, refs, urls)).toBe(
      '<img src="data:image/svg+xml;base64,AAA#logo">'
      + '<style>.a{background:url(data:image/svg+xml;base64,BBB#download)}</style>',
    );
  });

  it('无 fragment 时不多加 `#`', () => {
    const html = '<img src="a.png">';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    expect(refs[0].fragment).toBe('');
    expect(applyHtmlResourceUrls(html, refs, new Map([['/Users/me/drafts/a.png', 'data:image/png;base64,X']])))
      .toBe('<img src="data:image/png;base64,X">');
  });

  it('同一 SVG 的不同 fragment 只取一次件', () => {
    const refs = collectHtmlLocalResourceRefs('<img src="s.svg#a"><img src="s.svg#b">', BASE);
    expect(planHtmlResourceFetches(refs).targets).toEqual([
      { absPath: '/Users/me/drafts/s.svg', mimeType: 'image/svg+xml' },
    ]);
  });
});

describe('整页内联总量预算(不可信产物的 DoS 面)', () => {
  it('逐文件上限挡不住总量:预算用尽后不再取件', async () => {
    // 32 个接近单文件上限的资源 ≈ 85 MiB base64,取件 Map / 回填 HTML / WebView 序列化
    // 会同时各持一份,足以 OOM(review P1)。
    const targets = Array.from({ length: 10 }, (_, i) => ({
      absPath: `/a${i}.png`,
      mimeType: 'image/png',
    }));
    const chunk = 'x'.repeat(100);
    let calls = 0;
    const out = await fetchHtmlResourceUrls(
      targets,
      async () => {
        calls += 1;
        return chunk;
      },
      { concurrency: 1, totalBudgetChars: 250 },
    );
    // 250 字符预算装得下 2 个 100 字符的资源,第 3 个超预算被丢。
    expect(out.urlByAbsPath.size).toBe(2);
    expect(out.overBudget).toBe(8);
    expect(out.failed).toBe(0);
    // 预算耗尽后不再下载:第 3 个取回来才知道装不下(它置耗尽标记),之后 7 个直接跳过。
    // 若只比 usedChars >= budget,usedChars 会永远停在 200、早退从不触发,10 个全下载。
    expect(calls).toBe(3);
  });

  it('超预算的那个保留原引用,不占内存也不换错地址', async () => {
    const out = await fetchHtmlResourceUrls(
      [{ absPath: '/big.png', mimeType: 'image/png' }],
      async () => 'y'.repeat(500),
      { totalBudgetChars: 100 },
    );
    expect(out.urlByAbsPath.size).toBe(0);
    expect(out.overBudget).toBe(1);
  });

  it('预算内不受影响,且默认预算是显式常量', async () => {
    const out = await fetchHtmlResourceUrls(
      [{ absPath: '/a.png', mimeType: 'image/png' }],
      async () => 'data:image/png;base64,AAA',
    );
    expect(out.urlByAbsPath.size).toBe(1);
    expect(out.overBudget).toBe(0);
    expect(HTML_RESOURCE_TOTAL_MAX_CHARS).toBeGreaterThan(0);
  });
});

describe('惰性文本不占取件配额(注释 / 脚本体 / CSS 注释)', () => {
  it('掩码等长,且只抹内容不动换行', () => {
    const html = '<!-- x -->\n<img src="a.png">';
    const masked = maskInertHtmlText(html);
    expect(masked.length).toBe(html.length);
    expect(masked.split('\n')).toHaveLength(2);
    // 注释整段变空白,真标记原样留下。
    expect(masked.startsWith('          \n')).toBe(true);
    expect(masked).toContain('<img src="a.png">');
  });

  it('注释里的伪资源不进候选(不再挤占 32 项配额)', () => {
    const fake = Array.from({ length: 40 }, (_, i) => `<img src="old${i}.png">`).join('');
    const refs = collectHtmlLocalResourceRefs(`<!--${fake}--><img src="real.png">`, BASE);
    expect(refs.map((r) => r.raw)).toEqual(['real.png']);
  });

  it('脚本体里的伪标记与 url() 不进候选,但 <script src> 本身仍取', () => {
    const html = '<script src="app.js">var s = \'<img src="fake.png">\'; var u = "url(fake2.png)";</script>';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    expect(refs.map((r) => r.raw)).toEqual(['app.js']);
  });

  it('CSS 注释里的 url() 不进候选,同块内真 url() 照旧取', () => {
    const html = '<style>/* url(old.png) */ body { background: url(new.png); }</style>';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    expect(refs.map((r) => r.raw)).toEqual(['new.png']);
  });

  it('未闭合注释 / 未闭合脚本掩到文末(真 parser 同样吞掉后面)', () => {
    expect(collectHtmlLocalResourceRefs('<!-- <img src="a.png">', BASE)).toEqual([]);
    expect(collectHtmlLocalResourceRefs('<script>x<img src="a.png">', BASE)).toEqual([]);
  });

  it('注释里出现 <script> 开标签不得把后面的真资源一起抹掉', () => {
    // 扫脚本体时若扫的是原文,这个开标签没有配对 </script>,会按未闭合掩到文末。
    const refs = collectHtmlLocalResourceRefs('<!-- <script> --><img src="real.png">', BASE);
    expect(refs.map((r) => r.raw)).toEqual(['real.png']);
  });

  it('回填下标仍对齐原文(掩码只服务扫描)', () => {
    const html = '<!-- url(old.png) --><style>body{background:url(new.png)}</style>';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    expect(refs).toHaveLength(1);
    expect(html.slice(refs[0].start, refs[0].end)).toBe('new.png');
    const out = applyHtmlResourceUrls(html, refs, new Map([[refs[0].absPath, 'data:image/png;base64,AAA']]));
    expect(out).toContain('url(data:image/png;base64,AAA)');
    // 注释原文一字不动。
    expect(out).toContain('<!-- url(old.png) -->');
  });
});
