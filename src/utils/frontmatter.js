// src/utils/frontmatter.js

/**
 * Format tags as YAML block-list for Obsidian compatibility.
 * Obsidian requires block-list format (- tag) not flow-sequence ([tag1, tag2]).
 * @param {string[]} tags - Array of tag strings
 * @returns {string} YAML-formatted tags line(s)
 */
export function formatYamlTags(tags) {
  if (!tags || !Array.isArray(tags)) return 'tags: []';
  const cleaned = tags.map(t => t.trim()).filter(Boolean);
  if (cleaned.length === 0) return 'tags: []';
  return 'tags:\n' + cleaned.map(t => {
    // Quote tags containing YAML-special characters
    if (/[:#\[\]*&!|>{},%@`]/.test(t) || t.includes("'") || t.includes('"')) {
      return `  - "${t.replace(/"/g, '\\"')}"`;
    }
    return `  - ${t}`;
  }).join('\n');
}
