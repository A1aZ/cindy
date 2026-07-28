import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';

export type EditorTextRange = {
  from: number;
  to: number;
};

/**
 * Snap a position onto the nearest place that can hold inline content.
 *
 * Dictation positions must always address inline content: the transcript is
 * inserted with `tr.insertText`, and the live draft/caret decorations are inline
 * widgets. A position whose parent is NOT a textblock (0, or a boundary between
 * two blocks) makes ProseMirror wrap the inserted text in a NEW paragraph — the
 * transcript then lands one line below, leaving an empty paragraph in front of
 * it — and renders the widgets at doc level, where the browser gives them their
 * own line. Both read as "dictation added a stray blank line".
 *
 * Anchors reach such a position whenever the composer document is rebuilt
 * wholesale while dictation is live (an external draft restore replaces the full
 * document), because mapping an anchor across a full replacement pushes it out
 * to the block boundary. Clamping to `doc.content.size` alone does not help:
 * that upper bound is itself a block boundary.
 */
export function clampToInlinePosition(doc: PMNode, position: number): number {
  const clamped = Math.max(0, Math.min(position, doc.content.size));
  const $pos = doc.resolve(clamped);
  if ($pos.parent.isTextblock) return clamped;
  return TextSelection.near($pos, 1).from;
}

/** Clamp a stored range into valid, ordered inline positions of `doc`. */
export function clampEditorTextRangeToDoc(range: EditorTextRange, doc: PMNode): EditorTextRange {
  const from = clampToInlinePosition(doc, Math.min(range.from, range.to));
  const to = clampToInlinePosition(doc, Math.max(range.from, range.to));
  return from <= to ? { from, to } : { from, to: from };
}

/**
 * Move a stored range through a document change, so offsets captured earlier
 * keep pointing at the same content.
 *
 * The association arguments are what keep text inserted exactly at a boundary
 * OUTSIDE the range: `1` pushes `from` past such an insertion, `-1` holds `to`
 * in front of it. (The opposite pair — the intuitive-looking "bias outward" —
 * grows the range around the new text, which the next replacement would then
 * overwrite.) A collapsed cursor gets pushed both ways at once and ends up
 * inverted; keep it collapsed after the insertion rather than letting a
 * downstream min/max clamp swap it back into a range spanning that text.
 *
 * The mapped result is snapped back onto inline positions: a full-document
 * replacement maps every anchor out to a block boundary, which is not a place
 * dictation may insert at (see `clampToInlinePosition`).
 *
 * Lives in its own module so it can be tested without pulling in the voice
 * input hook and its Electron bridge.
 */
export function mapEditorTextRange(
  range: EditorTextRange | null,
  transaction: Transaction,
): EditorTextRange | null {
  if (!range) return null;
  const from = transaction.mapping.map(range.from, 1);
  const to = transaction.mapping.map(range.to, -1);
  return clampEditorTextRangeToDoc(from > to ? { from, to: from } : { from, to }, transaction.doc);
}
