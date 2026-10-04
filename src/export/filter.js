// src/export/filter.js — filter DSL → SQL query builder (Ship 1b)
// Tag matching is exact against normalized tags. NOT LIKE '%x%'.
// general_infra expands to a frozen tag list written into manifest.filter_expanded.

import { normalizeTags } from './tags.js';
import { getDb } from '../db.js';

/**
 * Frozen list of tags that expand from general_infra: true.
 * Written into manifest.filter_expanded for reproducibility.
 */
export const GENERAL_INFRA_TAGS = Object.freeze([
  'hetzner',
  'docker',
  'infrastructure',
  'operational',
  'stripe',
  'traefik',
  'caddy',
  'nginx',
  'reverse-proxy',
  'authentik',
  'storage-box',
  'vps',
  'networking',
]);

/**
 * Normalize a filter spec object.
 * Lowercases/trims all tag values. Fills missing fields with defaults.
 * @param {object} rawFilter
 * @returns {object} normalized filter
 */
export function normalizeFilter(rawFilter = {}) {
  const inc = rawFilter.include || {};
  const exc = rawFilter.exclude || {};
  return {
    include: {
      tags_any: normalizeTags(inc.tags_any || []),
      tags_all: normalizeTags(inc.tags_all || []),
      doc_type: (inc.doc_type || []).map(t => String(t).toLowerCase().trim()).filter(Boolean),
      title_glob: inc.title_glob || null,
      date_from: inc.date_from || null,
      date_to: inc.date_to || null,
      ids: (inc.ids || []).map(Number).filter(n => !isNaN(n)),
    },
    exclude: {
      tags_any: normalizeTags(exc.tags_any || []),
      ids: (exc.ids || []).map(Number).filter(n => !isNaN(n)),
    },
    general_infra: Boolean(rawFilter.general_infra),
  };
}

/**
 * Convert a normalized filter spec to a WHERE clause + params for the documents table.
 *
 * Returns: { where: string, params: any[], filterExpanded: object }
 *
 * Join required: the query must join vault_files on d.id = vf.document_id (for file info).
 */
export function filterToSQL(filter) {
  const conditions = [];
  const params = [];
  const filterExpanded = {};

  // Expand general_infra
  let allIncludeTags = [...filter.include.tags_any];
  if (filter.general_infra) {
    allIncludeTags = [...new Set([...allIncludeTags, ...GENERAL_INFRA_TAGS])];
    filterExpanded.general_infra_expanded_tags = [...GENERAL_INFRA_TAGS];
  }

  // Exact tag matching: we use a helper to check tags column for each normalized tag.
  // Tags are stored as comma-separated strings in the DB (e.g. "cutdacord, jellyfin, docker").
  // We normalize both sides: split on comma+whitespace, lowercase, trim.
  // Matching strategy: use glob-based patterns for each tag token.

  function buildTagCondition(tagList, mode) {
    // mode: 'any' or 'all'
    // Build: (tags LIKE '%,cutdacord,%' OR tags = 'cutdacord' OR ...) etc.
    // To avoid LIKE '%x%' false positives, we check for:
    //   - tag is the entire tags value: d.tags = ?
    //   - tag is at the start: d.tags LIKE '? %' OR d.tags LIKE '?,%'
    //   - tag is in the middle: d.tags LIKE '%, ?,%' OR d.tags LIKE '%, ? %'
    //   - tag is at the end: d.tags LIKE '%, ?' OR d.tags LIKE '%,?'
    // Simplification: since tags are stored space-after-comma, we use:
    //   d.tags = tag  OR  d.tags LIKE 'tag,%'  OR  d.tags LIKE '%, tag,%'  OR  d.tags LIKE '%, tag'
    if (tagList.length === 0) return null;

    const tagSubClauses = tagList.map(tag => {
      // Match exact tag in comma-separated list (tags stored as "tag1, tag2, tag3")
      params.push(tag, `${tag},%`, `%, ${tag},%`, `%, ${tag}`, `%,${tag}`, `${tag} %`);
      return `(LOWER(d.tags) = ? OR LOWER(d.tags) LIKE ? OR LOWER(d.tags) LIKE ? OR LOWER(d.tags) LIKE ? OR LOWER(d.tags) LIKE ? OR LOWER(d.tags) LIKE ?)`;
    });

    if (mode === 'any') {
      return `(${tagSubClauses.join(' OR ')})`;
    } else {
      // all: each tag must match
      return `(${tagSubClauses.join(' AND ')})`;
    }
  }

  // Include: tags_any (OR semantics: doc must match at least one)
  if (allIncludeTags.length > 0) {
    const clause = buildTagCondition(allIncludeTags, 'any');
    if (clause) conditions.push(clause);
  }

  // Include: tags_all (AND semantics: doc must match all)
  if (filter.include.tags_all.length > 0) {
    const clause = buildTagCondition(filter.include.tags_all, 'all');
    if (clause) conditions.push(clause);
  }

  // Include: doc_type
  if (filter.include.doc_type.length > 0) {
    const placeholders = filter.include.doc_type.map(() => '?').join(', ');
    conditions.push(`d.doc_type IN (${placeholders})`);
    params.push(...filter.include.doc_type);
  }

  // Include: title_glob
  if (filter.include.title_glob && filter.include.title_glob !== '*') {
    // Convert glob to SQL LIKE: * → %
    const likePattern = filter.include.title_glob.replace(/\*/g, '%').replace(/\?/g, '_');
    conditions.push('d.title LIKE ?');
    params.push(likePattern);
  }

  // Include: date_from / date_to
  if (filter.include.date_from) {
    conditions.push('d.created_at >= ?');
    params.push(filter.include.date_from);
  }
  if (filter.include.date_to) {
    conditions.push('d.created_at <= ?');
    params.push(filter.include.date_to + 'T23:59:59Z');
  }

  // Include: explicit IDs (these take precedence — OR with other conditions)
  if (filter.include.ids.length > 0) {
    // IDs are OR'd with the rest; wrap existing conditions and add id clause
    const idPlaceholders = filter.include.ids.map(() => '?').join(', ');
    const idClause = `d.id IN (${idPlaceholders})`;
    if (conditions.length > 0) {
      const wrapped = `(${conditions.join(' AND ')} OR ${idClause})`;
      conditions.length = 0;
      conditions.push(wrapped);
    } else {
      conditions.push(idClause);
    }
    params.push(...filter.include.ids);
  }

  // Exclude: tags_any
  if (filter.exclude.tags_any.length > 0) {
    const excludeClause = buildTagCondition(filter.exclude.tags_any, 'any');
    if (excludeClause) {
      conditions.push(`NOT ${excludeClause}`);
    }
  }

  // Exclude: explicit IDs
  if (filter.exclude.ids.length > 0) {
    const idPlaceholders = filter.exclude.ids.map(() => '?').join(', ');
    conditions.push(`d.id NOT IN (${idPlaceholders})`);
    params.push(...filter.exclude.ids);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Record resolved IDs for manifest.filter_expanded
  // (done after query execution, not here)

  return { where, params, filterExpanded };
}

/**
 * Execute a filter query and return matching document rows.
 * @param {object} filter - normalized filter spec
 * @returns {{ rows: object[], filterExpanded: object }}
 */
export function queryByFilter(filter) {
  const { where, params, filterExpanded } = filterToSQL(filter);

  const sql = `
    SELECT
      vf.vault_path,
      vf.content_hash,
      vf.title AS vf_title,
      vf.note_type,
      vf.tags AS vf_tags,
      d.id AS doc_id,
      d.title AS doc_title,
      d.doc_type,
      d.tags AS doc_tags,
      d.file_path,
      d.file_size
    FROM documents d
    LEFT JOIN vault_files vf ON vf.document_id = d.id
    ${where}
    ORDER BY vf.vault_path
  `;

  const rows = getDb().prepare(sql).all(...params);

  // Capture resolved IDs for manifest.filter_expanded
  filterExpanded.resolved_ids = rows.map(r => r.doc_id).filter(Boolean);

  return { rows, filterExpanded };
}
