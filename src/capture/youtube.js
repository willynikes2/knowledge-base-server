import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { formatYamlTags } from '../utils/frontmatter.js';

export function captureYouTube({ title, url, transcript, channel, tags }, vaultPath) {
  const destDir = join(vaultPath, 'sources', 'youtube');
  mkdirSync(destDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  const filename = `${date}-${slug}.md`;
  const filePath = join(destDir, filename);

  if (existsSync(filePath)) {
    return { created: false, path: `sources/youtube/${filename}`, reason: 'already exists' };
  }

  const tagList = tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [];
  tagList.push('youtube');

  const fm = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `type: source`,
    `source: youtube`,
    `url: "${url}"`,
    channel ? `channel: "${channel}"` : null,
    `created: "${date}"`,
    `updated: "${date}"`,
    formatYamlTags(tagList),
    `status: inbox`,
    '---',
  ].filter(Boolean).join('\n');

  const body = `# ${title}\n\n**Source:** [${channel || 'YouTube'}](${url})\n\n## Transcript\n\n${transcript}\n`;
  writeFileSync(filePath, `${fm}\n\n${body}`);

  return { created: true, path: `sources/youtube/${filename}` };
}
