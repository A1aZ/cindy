/**
 * 外部主题导入的颜色解析与派生工具（纯函数，无 IO / 无 DOM）。
 *
 * 只服务 theme-import：把 VSCode 主题 JSON 与 Obsidian theme.css 里出现的各种
 * 颜色写法归一成 RGB，再按 Cindy token 需要的两种形态输出——hex（`--surface`
 * 一类）与 HSL 三元组（`--surface-hsl` 一类，消费点写 `hsl(var(--xxx))`）。
 *
 * 算法与 `renderer/themes/__tests__/cindyThemes.test.ts` 的 parseHex / hslToRgb
 * 同源（sRGB + WCAG 相对亮度），保证导入产物与既有主题的对比度口径一致。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_RE = /^#?([0-9a-f]{3,8})$/i;

function clamp255(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 展开 3/4 位简写 hex；返回 6 位（丢弃 alpha——Cindy token 不消费源主题的透明度）。 */
function expandHex(body: string): string | null {
  if (body.length === 3 || body.length === 4) {
    const rgb = body.slice(0, 3);
    return rgb
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (body.length === 6) return body;
  // 8 位 = #rrggbbaa：剥离 alpha。VSCode 主题里 border / overlay 类色值大量带
  // alpha，直接当不透明色用即可（我们的目标 token 都是实色槽位）。
  if (body.length === 8) return body.slice(0, 6);
  return null;
}

function parseHex(raw: string): Rgb | null {
  const m = HEX_RE.exec(raw.trim());
  if (!m) return null;
  const body = expandHex(m[1]);
  if (!body) return null;
  const n = Number.parseInt(body, 16);
  if (!Number.isFinite(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** HSL(0-360, 0-1, 0-1) → RGB。 */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return {
    r: clamp255((r1 + m) * 255),
    g: clamp255((g1 + m) * 255),
    b: clamp255((b1 + m) * 255),
  };
}

function parseNumberList(body: string): number[] | null {
  const parts = body
    .split(/[,/\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 3) return null;
  return parts.slice(0, 4).map((p) => {
    if (p.endsWith('%')) return Number.parseFloat(p.slice(0, -1));
    return Number.parseFloat(p);
  });
}

function parseFunctional(raw: string): Rgb | null {
  const m = /^(rgba?|hsla?)\(([^)]*)\)$/i.exec(raw.trim());
  if (!m) return null;
  const fn = m[1].toLowerCase();
  const nums = parseNumberList(m[2]);
  if (!nums || nums.some((n) => !Number.isFinite(n))) return null;
  if (fn.startsWith('rgb')) {
    // rgb() 的百分号形态少见但合法；这里按原值处理即可（0-255 与 0-100 混用时
    // 也不会崩，只是取近似——源主题几乎不用百分号 rgb）。
    return { r: clamp255(nums[0]), g: clamp255(nums[1]), b: clamp255(nums[2]) };
  }
  return hslToRgb(nums[0], clamp01(nums[1] / 100), clamp01(nums[2] / 100));
}

/**
 * 解析一个 CSS 颜色字面量。支持 hex(3/4/6/8 位)、`rgb()/rgba()`、`hsl()/hsla()`。
 * 不支持 `color-mix()` / `var()` / 命名色等需要上下文或色彩空间转换的写法——
 * 返回 null，由调用方计入「无法解析」报告，绝不猜值。
 */
export function parseCssColor(raw: string | undefined | null): Rgb | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  return parseHex(value) ?? parseFunctional(value);
}

/** RGB → 小写 6 位 hex（与 colors.ts 既有默认值的书写形态一致）。 */
export function toHex({ r, g, b }: Rgb): string {
  const hex = ((clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b))
    .toString(16)
    .padStart(6, '0');
  return `#${hex}`;
}

/**
 * RGB → `"H S% L%"` 三元组（Cindy `-hsl` token 的形态，消费点写
 * `hsl(var(--xxx))`）。分量四舍五入取整，与既有主题里手写的三元组同格式。
 */
export function toHslTriplet({ r, g, b }: Rgb): string {
  const rn = clamp255(r) / 255;
  const gn = clamp255(g) / 255;
  const bn = clamp255(b) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/** `rgba(r, g, b, a)` 形态（既有主题的 drop-overlay-bg 就是这个书写形态）。 */
export function toRgbaString({ r, g, b }: Rgb, alpha: number): string {
  return `rgba(${clamp255(r)}, ${clamp255(g)}, ${clamp255(b)}, ${alpha})`;
}

/** WCAG 相对亮度。 */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (v: number): number => {
    const n = clamp255(v) / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 对比度（1–21）。 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 背景是否偏暗——用于在源主题没声明 light/dark 时判定主题类型。 */
export function isDarkBackground(rgb: Rgb): boolean {
  return relativeLuminance(rgb) < 0.2;
}

/** 朝白/黑方向线性插值：amount>0 提亮，amount<0 压暗（0–1 比例）。 */
export function shade(rgb: Rgb, amount: number): Rgb {
  const target = amount >= 0 ? 255 : 0;
  const t = Math.abs(clamp01(Math.abs(amount)));
  return {
    r: clamp255(rgb.r + (target - rgb.r) * t),
    g: clamp255(rgb.g + (target - rgb.g) * t),
    b: clamp255(rgb.b + (target - rgb.b) * t),
  };
}

/** 两色线性混合（t=0 取 a，t=1 取 b）。 */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t);
  return {
    r: clamp255(a.r + (b.r - a.r) * k),
    g: clamp255(a.g + (b.g - a.g) * k),
    b: clamp255(a.b + (b.b - a.b) * k),
  };
}
