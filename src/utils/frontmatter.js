// src/utils/frontmatter.js
import matter from 'gray-matter';

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


const refuse = () => { throw new Error('only YAML note headers are read'); };
const DATA_ONLY = { engines: { javascript: refuse, js: refuse, coffee: refuse, coffeescript: refuse, cson: refuse, toml: refuse, json: refuse } };

/**
 * Read a note's header and body. A note header is data: only a YAML header is read.
 * A header that names another language (for example a code language) is refused, so nothing in a note is ever run.
 * @param {string} content - the whole note
 * @returns {{ data: object, content: string }}
 */
export function readNote(content) {
  const declared = String(content).match(/^---[ \t]*([A-Za-z0-9_-]+)[ \t]*\r?\n/)?.[1];
  if (declared && !/^ya?ml$/i.test(declared)) refuse();
  const { data, content: body } = matter(String(content), DATA_ONLY);
  return { data, content: body };
}

/** Write a note from a body and a header object (YAML). */
export function writeNote(body, data) {
  return matter.stringify(body, data);
}
