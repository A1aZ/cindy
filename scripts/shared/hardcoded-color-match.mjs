/** Shared lexical colour scan for inventory and added-line audit. Offsets refer to
 * original source. Computed channels, named colours and concatenation still need
 * review; this scanner is not a CSS evaluator (governance §13). */
export function maskColorComments(text) {
  return String(text).replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->/g,
    (part) => /^(?:\/\*|\/\/|<!--)/.test(part) ? part.replace(/[^\r\n]/g, ' ') : part,
  );
}

function closeParen(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Traverse semantic wrappers too: var() must never hide a literal fallback. */
export function findBareColors(text) {
  const source = maskColorComments(text);
  const hits = [];
  const add = (value, index, end = index + value.length) => hits.push({ value, index, end });
  for (const match of source.matchAll(/#[\da-f]+\b/gi)) {
    const value = match[0];
    if (![4, 5, 7, 9].includes(value.length)) continue;
    const before = source.slice(0, match.index);
    const after = source.slice(match.index + value.length);
    // CSS/hash literals, quoted colour values and Tailwind arbitrary values.
    // Prose PR numbers, URLs, HTML entities and CSS ID selectors are not colours.
    if (/(?:\bPR|\bissue|\bpull)\s*$/i.test(before)) continue;
    if (/\[$/.test(before) && /^[^\]\n]*\]\(/.test(after)) continue;
    if (/^\s*\{/.test(after) || /(?:href|url)\s*[=(]\s*["']?$/i.test(before)) continue;
    const literalStart = /["'`:=\[]\s*$/.test(before);
    const declaration = /\b(?:[\w-]*color|background(?:-[\w-]+)?|border(?:-[\w-]+)?|fill|stroke|(?:box|text)-shadow|boxShadow|textShadow|outline)\s*:\s*[^;{}\n]*$/i.test(before);
    const cssFunction = /\b(?:var|(?:repeating-)?(?:linear|radial|conic)-gradient|color-mix|(?:rgb|hsl)a?|drop-shadow)\([^;{}\n]*$/i.test(before);
    const arbitrary = /[\w-]+-\[[^\]\n]*$/.test(before);
    if (!literalStart && !declaration && !cssFunction && !arbitrary && source.trim() !== value) continue;
    add(value, match.index);
  }
  for (const match of source.matchAll(/\b(?:rgba?|hsla?|oklch|oklab|lch|lab|hwb|color)\s*\(/gi)) {
    const open = match.index + match[0].length - 1;
    const close = closeParen(source, open);
    if (close < 0) continue; // e.g. a documented function prefix, not a colour value
    const body = source.slice(open + 1, close);
    // Fully literal channels are bare colour. Nested literal functions and hex
    // remain independently visible even when the outer function uses variables.
    const channels = body.replace(/_/g, ' ').trim();
    const numeric = '(?:[+-]?(?:\\d*\\.)?\\d+(?:e[+-]?\\d+)?(?:%|deg|rad|grad|turn)?|none)';
    const channelList = new RegExp(`^${numeric}(?:[\\s,/]+${numeric}){2,3}$`, 'i');
    const literal = /^color\s*\(/i.test(match[0])
      ? /^(?:srgb(?:-linear)?|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz(?:-d50|-d65)?)\s+/i.test(channels)
        && channelList.test(channels.replace(/^\S+\s+/, ''))
      : channelList.test(channels);
    if (literal) add(source.slice(match.index, close + 1), match.index, close + 1);
  }
  return hits.sort((a, b) => a.index - b.index);
}

export function matchBareColors(text) {
  return findBareColors(text).map((hit) => hit.value);
}
