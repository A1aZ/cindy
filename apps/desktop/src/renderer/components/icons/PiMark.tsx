/**
 * PiMark —— pi coding agent(earendil-works/pi)的身份 mark。
 *
 * pi 上游没有对外的品牌 glyph 规范,这里用块状笔画的 π 字形,笔画粗细与
 * ClaudeMark 像素脸 / CodexMark `>_` 花形的视觉重量对齐。
 *  - variant="mono"(默认):currentColor,跟随主题/状态染色;
 *  - variant="brand":pi 无官方品牌色,当前与 mono 相同(保留参数是为了与
 *    ClaudeMark/CodexMark 的调用面一致,出现官方色后只改这里)。
 */

interface PiMarkProps {
  size?: number;
  className?: string;
  variant?: 'mono' | 'brand';
}

export function PiMark({ size = 14, className }: PiMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <g fill="currentColor">
        {/* 横梁 */}
        <rect x="3" y="5" width="18" height="3.4" rx="1.2" />
        {/* 左腿(直) */}
        <rect x="6.4" y="7.2" width="3.4" height="11.8" rx="1.2" />
        {/* 右腿(底部外撇一点,呼应手写 π 的收笔) */}
        <path d="M14.4 7.2h3.4v9.2c0 .9.4 1.4 1.2 1.4h.6c.3 0 .4.14.4.42v1.36c0 .28-.14.42-.42.42h-1.3c-2.5 0-3.88-1.3-3.88-3.7V7.2Z" />
      </g>
    </svg>
  );
}
