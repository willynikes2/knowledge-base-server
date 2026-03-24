import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { formatYamlTags } from '../utils/frontmatter.js';

export function parseXBookmarks(bookmarksPath) {
  const content = readFileSync(bookmarksPath, 'utf-8');
  const bookmarks = [];
  let current = null;

  for (const line of content.split('\n')) {
    const linkMatch = line.match(/^#{1,3}\s+\[(.+?)\]\((.+?)\)/);
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);

    if (linkMatch) {
      if (current) bookmarks.push(current);
      current = { title: linkMatch[1], url: linkMatch[2], body: '' };
    } else if (headingMatch && !current) {
      current = { title: headingMatch[1], url: null, body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) bookmarks.push(current);

  return bookmarks;
}

export function captureXBookmarks(bookmarksPath, vaultPath) {
  const bookmarks = parseXBookmarks(bookmarksPath);
  const destDir = join(vaultPath, 'sources', 'x-bookmarks');
  mkdirSync(destDir, { recursive: true });

  let created = 0;
  let skipped = 0;

  for (const bm of bookmarks) {
    const slug = bm.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const filename = `${slug}.md`;
    const filePath = join(destDir, filename);

    if (existsSync(filePath)) {
      skipped++;
      continue;
    }

    const date = new Date().toISOString().split('T')[0];
    const fm = [
      '---',
      `title: "${bm.title.replace(/"/g, '\\"')}"`,
      `type: source`,
      `source: x`,
      bm.url ? `url: "${bm.url}"` : null,
      `created: "${date}"`,
      `updated: "${date}"`,
      formatYamlTags(['x', 'bookmark']),
      `status: inbox`,
      '---',
    ].filter(Boolean).join('\n');

    writeFileSync(filePath, `${fm}\n\n# ${bm.title}\n\n${bm.body.trim()}\n`);
    created++;
  }

  return { created, skipped, total: bookmarks.length };
}
