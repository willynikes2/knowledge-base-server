import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { formatYamlTags } from '../utils/frontmatter.js';

export function captureWeb({ title, url, content, tags, project }, vaultPath) {
  const destDir = join(vaultPath, 'sources', 'web');
  mkdirSync(destDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  const filename = `${date}-${slug}.md`;
  const filePath = join(destDir, filename);

  if (existsSync(filePath)) {
    return { created: false, path: `sources/web/${filename}` };
  }

  const tagList = tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [];
  tagList.push('web');

  const fm = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `type: source`,
    `source: web`,
    `url: "${url}"`,
    `created: "${date}"`,
    `updated: "${date}"`,
    formatYamlTags(tagList),
    project ? `project: ${project}` : null,
    `status: inbox`,
    '---',
  ].filter(Boolean).join('\n');

  writeFileSync(filePath, `${fm}\n\n# ${title}\n\n**Source:** ${url}\n\n${content}\n`);
  return { created: true, path: `sources/web/${filename}` };
}
