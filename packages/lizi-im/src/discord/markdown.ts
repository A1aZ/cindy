interface Segment {
  kind: 'code' | 'text';
  content: string;
}

export function markdownToDiscord(md: string): { text: string; imageUrls: string[] } {
  const imageUrls: string[] = [];
  const text = splitByCodeFence(md)
    .map((segment) =>
      segment.kind === 'code' ? segment.content : convertTextSegment(segment.content, imageUrls),
    )
    .join('');

  return { text, imageUrls };
}

function splitByCodeFence(text: string): Segment[] {
  const segments: Segment[] = [];
  const re = /```[\s\S]*?(?:```|$)/g;
  let last = 0;

  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ kind: 'text', content: text.slice(last, index) });
    segments.push({ kind: 'code', content: match[0] });
    last = index + match[0].length;
  }

  if (last < text.length) segments.push({ kind: 'text', content: text.slice(last) });
  return segments;
}

function convertTextSegment(segment: string, imageUrls: string[]): string {
  const withoutXdtImages = extractXdtImageLines(segment, imageUrls);
  const withoutHtml = stripHtmlTags(withoutXdtImages);
  return wrapTables(withoutHtml);
}

function extractXdtImageLines(segment: string, imageUrls: string[]): string {
  const lines = segment.split('\n');
  const kept: string[] = [];
  // 双协议:老 xdt-image + 媒体总仓 cindy-media(与 xdtRefs.XDT_IMAGE_REGEX 口径一致)。
  const xdtImageRe = /!\[[^\]]*]\(((?:xdt-image|cindy-media):\/\/[^)]+)\)/g;

  for (const line of lines) {
    let hasXdtImage = false;
    const withoutXdtImages = line.replace(xdtImageRe, (_token, url: string) => {
      hasXdtImage = true;
      imageUrls.push(url);
      return '';
    });

    if (hasXdtImage) {
      const cleanedLine = withoutXdtImages.replace(/[ \t]{2,}/g, ' ').trim();
      if (cleanedLine.length > 0) {
        kept.push(cleanedLine);
      }
    } else {
      kept.push(line);
    }
  }

  return kept.join('\n');
}

function stripHtmlTags(text: string): string {
  return text.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>\n]*)?\/?>/g, '');
}

function wrapTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (isTableStart(lines, i)) {
      const tableLines = [lines[i], lines[i + 1]];
      i += 2;

      while (i < lines.length && isTableBodyLine(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      i -= 1;

      out.push('```', ...tableLines, '```');
      continue;
    }

    out.push(lines[i]);
  }

  return out.join('\n');
}

function isTableStart(lines: string[], index: number): boolean {
  return isTableBodyLine(lines[index]) && isTableSeparatorLine(lines[index + 1] ?? '');
}

function isTableBodyLine(line: string): boolean {
  return line.includes('|') && line.trim().length > 0;
}

function isTableSeparatorLine(line: string): boolean {
  const cells = line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}
