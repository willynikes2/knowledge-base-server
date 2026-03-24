import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseVaultNote } from '../vault/parser.js';
import { CLASSIFY_PROMPT, PROMOTE_PROMPT } from './prompts.js';
import { formatYamlTags } from '../utils/frontmatter.js';

// Promotion destinations by classification
const DEST_MAP = {
  research: 'research',
  idea: 'ideas',
  workflow: 'workflows',
  lesson: 'agents/lessons',
  decision_candidate: 'decisions',
  architecture: 'decisions',
};

export async function promoteNote(notePath, vaultPath, llmCall) {
  const fullPath = join(vaultPath, notePath);
  if (!existsSync(fullPath)) return null;

  const content = readFileSync(fullPath, 'utf-8');
  const parsed = parseVaultNote(content, notePath);

  // Skip if already promoted (not in sources/inbox)
  if (!notePath.startsWith('inbox') && !notePath.startsWith('sources') &&
      !notePath.startsWith('Clippings')) {
    return { skipped: true, reason: 'not a source/inbox note' };
  }

  // Classify
  const classifyPrompt = CLASSIFY_PROMPT
    .replace('{title}', parsed.title)
    .replace('{source_type}', parsed.type)
    .replace('{content}', parsed.body.slice(0, 3000));

  const classification = await llmCall(classifyPrompt);
  let classData;
  try {
    classData = JSON.parse(classification);
  } catch {
    return { error: 'Failed to parse classification response' };
  }

  if (!classData.should_promote) {
    return { skipped: true, reason: 'classifier said do not promote' };
  }

  // Generate promoted note for each classification
  const results = [];
  for (const cls of classData.classifications) {
    const dest = DEST_MAP[cls];
    if (!dest) continue;

    const promotePrompt = PROMOTE_PROMPT
      .replace('{title}', parsed.title)
      .replace('{source_type}', parsed.type)
      .replace('{classification}', cls)
      .replace('{content}', parsed.body.slice(0, 3000));

    const promotedContent = await llmCall(promotePrompt);

    const date = new Date().toISOString().split('T')[0];
    const slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const filename = `${date}-${slug}.md`;
    const destDir = join(vaultPath, dest);
    mkdirSync(destDir, { recursive: true });

    const tags = [...(parsed.tags || []), cls];
    const fm = [
      '---',
      `title: "${parsed.title.replace(/"/g, '\\"')}"`,
      `type: ${cls}`,
      `source: "${notePath}"`,
      `created: "${date}"`,
      `updated: "${date}"`,
      formatYamlTags(tags),
      classData.projects?.[0] ? `project: ${classData.projects[0]}` : null,
      `status: active`,
      '---',
    ].filter(Boolean).join('\n');

    writeFileSync(join(destDir, filename), `${fm}\n\n${promotedContent}\n`);
    results.push({ classification: cls, path: `${dest}/${filename}` });
  }

  return {
    promoted: results,
    insight: classData.key_insight,
    business_angle: classData.business_angle,
    workflow_improvement: classData.workflow_improvement,
  };
}
