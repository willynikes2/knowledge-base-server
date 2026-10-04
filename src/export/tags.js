// src/export/tags.js — shared tag-normalization helper
// Tag matching is exact against normalized tags (lowercased, trimmed, split on comma/whitespace).
// Used by both the filter builder (Ship 1b) and export/restore for consistent semantics.

/**
 * Normalize a single raw tag value to a canonical string.
 * "  CutDaCord " → "cutdacord"
 * @param {string} raw
 * @returns {string}
 */
export function normalizeTag(raw) {
  return String(raw).toLowerCase().trim();
}

/**
 * Normalize a tags value from frontmatter or DB to a sorted array of canonical strings.
 * Handles: array, comma-separated string, whitespace-separated string, null/undefined.
 * @param {string|string[]|null|undefined} tags
 * @returns {string[]}
 */
export function normalizeTags(tags) {
  if (!tags) return [];
  const items = Array.isArray(tags)
    ? tags
    : String(tags).split(/[,\s]+/);
  return items
    .map(t => normalizeTag(t))
    .filter(t => t.length > 0);
}

/**
 * Check whether a document's normalized tags contain ALL of the query tags.
 * @param {string[]} docTags - already-normalized doc tags
 * @param {string[]} queryTags - already-normalized query tags
 * @returns {boolean}
 */
export function tagsMatchAll(docTags, queryTags) {
  const docSet = new Set(docTags);
  return queryTags.every(t => docSet.has(t));
}

/**
 * Check whether a document's normalized tags contain ANY of the query tags.
 * @param {string[]} docTags - already-normalized doc tags
 * @param {string[]} queryTags - already-normalized query tags
 * @returns {boolean}
 */
export function tagsMatchAny(docTags, queryTags) {
  if (queryTags.length === 0) return false;
  const docSet = new Set(docTags);
  return queryTags.some(t => docSet.has(t));
}
