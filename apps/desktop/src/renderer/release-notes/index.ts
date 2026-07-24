/**
 * release-notes/index.ts
 * ---------------------------------------------------------------------------
 * Per-version release notes are fetched from CDN by the main process and
 * delivered through `window.electronAPI.fetchReleaseNotes`. Platform routing
 * happens entirely in main (via getPlatformKey()), so the renderer only ever
 * deals with the version string.
 *
 * Successful results are memoised per version so that dismissing and
 * re-opening the dialog from the sidebar does not trigger another fetch.
 *
 * Schema: each section's `items` is an array of author groups
 *   { "name": "Lizi", "list": ["...", "..."] }
 * The dialog flattens these into one bullet per `list` entry under the
 * matching author sub-head.
 */

/** Per-item shape after flattening: one bullet with its author tag. */
export interface ReleaseNoteItem {
  text: string;
  /** Single author derived from the enclosing group's `name`. */
  by: string;
}

/** Author-grouped raw item as authored in the JSON. */
export interface RawReleaseNoteItem {
  name: string;
  list: string[];
}

export interface ReleaseNoteSection {
  title: string;
  items: ReleaseNoteItem[];
}

export interface ReleaseNotes {
  version: string;
  date: string;
  /** Flat contributor list — rendered as a single "Contributors" line. */
  contributors: string[];
  sections: ReleaseNoteSection[];
}

/** Fan out one author group into N flat items, one per `list` entry. */
function expandRawItem(raw: RawReleaseNoteItem): ReleaseNoteItem[] {
  return raw.list.map((text) => ({ text, by: raw.name }));
}

// ── In-memory cache (renderer-side) ────────────────────────────────────────

const cache = new Map<string, ReleaseNotes>();

// Version-index cache — one shot per session; the app version is immutable
// while the process lives, so a successful fetch never needs to repeat.
let indexCache: string[] | null = null;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch the sorted version-index from CDN via main. Used to determine which
 * intermediate versions to pull when the user upgrades across releases.
 * Returns null on failure — caller should fall back to showing the current
 * version only.
 */
export async function fetchReleaseNotesIndex(): Promise<string[] | null> {
  if (indexCache) return indexCache;
  const raw = await window.electronAPI.fetchReleaseNotesIndex();
  if (!raw) return null;
  indexCache = raw;
  return raw;
}

/**
 * Fetch release notes for the given version via the main-process CDN client.
 * Returns null when the CDN has no entry for this version on the current
 * platform, or when the network/parse fails.
 *
 * The CDN payload uses the same shape as `ReleaseNotes`, so no normalisation
 * is needed — we just memoise and return.
 */
export async function fetchReleaseNotes(
  version: string,
): Promise<ReleaseNotes | null> {
  const hit = cache.get(version);
  if (hit) return hit;

  const raw = await window.electronAPI.fetchReleaseNotes(version);
  if (!raw) return null;

  // Defensive default: tolerate older payloads missing `contributors`, and
  // normalise legacy string items into the object form.
  const notes: ReleaseNotes = {
    version: raw.version,
    date: raw.date,
    contributors: raw.contributors ?? [],
    sections: raw.sections.map((s) => ({
      title: s.title,
      items: (s.items as RawReleaseNoteItem[]).flatMap(expandRawItem),
    })),
  };
  cache.set(version, notes);
  return notes;
}
