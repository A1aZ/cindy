/**
 * OpenAI Web Search may encode source references in assistant text with
 * private-use delimiters such as `\uE200cite\uE202...\uE201`. Those tokens are
 * transport metadata, not user-facing prose. Some Codex app-server versions
 * expose only the flattened text and omit the structured URL annotations, so
 * client boundaries must remove the opaque marker deterministically.
 *
 * Grok / xAI may also leak the stop token `<|eos|>` as visible assistant
 * text, typically as a whole message after a tool-only wrap-up. That marker
 * is not user-facing prose either.
 */
const MODEL_STOP_TOKENS = new Set(['<|endoftext|>', '<|eot_id|>', '<|im_end|>', '<|eos|>']);
const MODEL_STOP_TOKEN_NAMES = ['endoftext', 'eot_id', 'im_end', 'eos'] as const;
const WEB_CITATION_OPEN = '\uE200cite\uE202';
const WEB_CITATION_CLOSE = '\uE201';

function unfinishedWebCitationOpen(text: string): number {
  let from = 0;
  for (;;) {
    const open = text.indexOf(WEB_CITATION_OPEN, from);
    if (open === -1) return -1;
    const close = text.indexOf(WEB_CITATION_CLOSE, open + WEB_CITATION_OPEN.length);
    if (close === -1) return open;
    from = close + WEB_CITATION_CLOSE.length;
  }
}

function partialWebCitationPrefixStart(text: string): number {
  const maxProbe = Math.min(text.length, WEB_CITATION_OPEN.length - 1);
  for (let length = maxProbe; length > 0; length -= 1) {
    if (text.endsWith(WEB_CITATION_OPEN.slice(0, length))) return text.length - length;
  }
  return text.length;
}

/**
 * Return the append-only prefix of a streaming assistant snapshot. A Web
 * citation tail is withheld until its closing delimiter arrives, because the
 * whole marker will disappear from the visible text once complete.
 */
export function stableInternalWebCitationBoundary(text: string): number {
  const unfinished = unfinishedWebCitationOpen(text);
  return unfinished === -1 ? partialWebCitationPrefixStart(text) : unfinished;
}

/**
 * Strip complete Web citation markers plus an unfinished final marker/prefix.
 * The payload is intentionally treated as opaque: private-use delimiters are
 * the exact compatibility boundary, while ordinary words such as "cite" are
 * left untouched. The transform is idempotent.
 */
export function stripInternalWebCitations(text: string): string {
  return stripStandaloneModelStopToken(stripInternalWebCitationMarkers(text));
}

function stripInternalWebCitationMarkers(text: string): string {
  if (!text.includes('\uE200')) return text;

  const stableEnd = stableInternalWebCitationBoundary(text);
  const stable = stableEnd === text.length ? text : text.slice(0, stableEnd);
  if (!stable.includes(WEB_CITATION_OPEN)) return stable;

  let output = '';
  let from = 0;
  for (;;) {
    const open = stable.indexOf(WEB_CITATION_OPEN, from);
    if (open === -1) return output + stable.slice(from);
    const close = stable.indexOf(WEB_CITATION_CLOSE, open + WEB_CITATION_OPEN.length);
    if (close === -1) return output + stable.slice(from, open);
    output += stable.slice(from, open);
    from = close + WEB_CITATION_CLOSE.length;
  }
}

/**
 * Drop a leaked model stop token only when it is the whole assistant
 * message (optional surrounding whitespace). Embedded mentions such as
 * `The token is <|eos|>` stay intact.
 */
export function stripStandaloneModelStopToken(text: string): string {
  return MODEL_STOP_TOKENS.has(text.trim()) ? '' : text;
}

/**
 * Return the append-only prefix of a streaming snapshot. A trailing
 * incomplete `<|eos` / `<|im_end` prefix is withheld until the closer
 * arrives, because a completed standalone token will disappear.
 */
export function stableStandaloneModelStopTokenBoundary(text: string): number {
  if (stripStandaloneModelStopToken(text) === '') return 0;

  const trimmedStart = text.trimStart();
  const leading = text.length - trimmedStart.length;
  const candidate = trimmedStart.trimEnd();
  if (!candidate.startsWith('<|')) return text.length;

  let longest = 0;
  for (const name of MODEL_STOP_TOKEN_NAMES) {
    const token = `<|${name}|>`;
    const maxProbe = Math.min(candidate.length, token.length - 1);
    for (let length = maxProbe; length > 0; length -= 1) {
      if (candidate === token.slice(0, length)) {
        longest = Math.max(longest, length);
        break;
      }
    }
  }
  return longest > 0 ? leading : text.length;
}
