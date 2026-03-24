import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { formatYamlTags } from '../utils/frontmatter.js';

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|token|secret|password|passwd|bearer)\s*[=:]\s*['"]?([^\s'"]{8,})/gi,
  /(?:sk-|pk-|rk-)[a-zA-Z0-9]{20,}/g,
  /(?:ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9]{36}/g,
  /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
  /(?:postgres|mysql|mongodb|redis):\/\/[^\s'"]+/gi,
  /(?:sk_live_|sk_test_|pk_live_|pk_test_)[a-zA-Z0-9]+/g,
];

function redact(text) {
  if (!text) return text;
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

export function captureSession({ goal, commands_failed, commands_worked, root_causes, fixes, lessons, project, machine }, vaultPath) {
  const sessDir = join(vaultPath, 'builds', 'sessions');
  mkdirSync(sessDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const time = new Date().toISOString().split('T')[1].slice(0, 5).replace(':', '');
  const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const filename = `${date}-${time}-${slug}.md`;

  const fm = [
    '---',
    `title: "${goal.replace(/"/g, '\\"')}"`,
    `type: session`,
    `created: "${date}"`,
    `updated: "${date}"`,
    project ? `project: ${project}` : null,
    machine ? `machine: ${machine}` : null,
    formatYamlTags(['terminal', 'session']),
    `status: active`,
    '---',
  ].filter(Boolean).join('\n');

  const sections = [`# ${goal}`];

  if (commands_failed) sections.push(`\n## Commands That Failed\n${redact(commands_failed)}`);
  if (commands_worked) sections.push(`\n## Commands That Worked\n${redact(commands_worked)}`);
  if (root_causes) sections.push(`\n## Root Causes\n${redact(root_causes)}`);
  if (fixes) sections.push(`\n## Fixes Applied\n${redact(fixes)}`);
  if (lessons) sections.push(`\n## Lessons\n${redact(lessons)}`);

  writeFileSync(join(sessDir, filename), `${fm}\n\n${sections.join('\n')}\n`);
  return { path: `builds/sessions/${filename}` };
}

export function captureFix({ title, symptom, cause, resolution, commands, project, stack }, vaultPath) {
  const fixDir = join(vaultPath, 'builds', 'fixes');
  mkdirSync(fixDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
  const filename = `${date}-${slug}.md`;

  const fm = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `type: fix`,
    `created: "${date}"`,
    `updated: "${date}"`,
    project ? `project: ${project}` : null,
    stack ? `stack: ${stack}` : null,
    formatYamlTags(['fix', 'terminal']),
    `status: active`,
    '---',
  ].filter(Boolean).join('\n');

  const body = [
    `# Fix: ${title}`,
    symptom ? `\n## Symptom\n${redact(symptom)}` : '',
    cause ? `\n## Cause\n${redact(cause)}` : '',
    resolution ? `\n## Resolution\n${redact(resolution)}` : '',
    commands ? `\n## Commands\n\`\`\`bash\n${redact(commands)}\n\`\`\`` : '',
  ].filter(Boolean).join('\n');

  writeFileSync(join(fixDir, filename), `${fm}\n\n${body}\n`);
  return { path: `builds/fixes/${filename}` };
}
