import { spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readNote, writeNote } from '../utils/frontmatter.js';
import { scanVault } from '../vault/indexer.js';

const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const CLASSIFY_MODEL = process.env.CLASSIFY_MODEL || 'claude-haiku-4-5-20251001';

const SUMMARIZE_PROMPT = `You are a knowledge base summarizer. Given a note, return ONLY valid JSON (no fencing):
{
  "summary": "1-2 sentence summary optimized for AI agent retrieval — what is this about and why would an agent need it (max 200 chars)",
  "key_topics": ["2-4 main topics/concepts"]
}

Be specific and actionable. The summary should help an AI agent decide if it needs to read the full document without actually reading it. Focus on WHAT information is available, not just the topic.`;

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_PATH, [
      '-p', '--model', CLASSIFY_MODEL,
      '--output-format', 'json',
      '--max-turns', '1',
    ], {
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      resolve(stdout);
    });
    proc.on('error', reject);
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export async function summarizeNote(title, content) {
  const prompt = `${SUMMARIZE_PROMPT}

Title: ${title}

${content.slice(0, 3000)}`;

  try {
    const stdout = await runClaude(prompt);
    const response = JSON.parse(stdout);
    const resultText = response.result || '';
    const jsonStr = resultText.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    return { success: true, ...JSON.parse(jsonStr) };
  } catch (err) {
    return { success: false, error: err.message, summary: title, key_topics: [] };
  }
}

export async function summarizeUnsummarized(vaultPath, { dryRun = false, limit = 0 } = {}) {
  const allFiles = scanVault(vaultPath);
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const needsSummary = [];

  for (const filePath of allFiles) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      if (!raw.trim()) continue;
      const { data: fm, content: body } = readNote(raw);
      if (fm.summary) continue; // already has summary
      if (body.trim().length < 100) continue; // too short to summarize
      needsSummary.push({ filePath, fm, body, rel: filePath.replace(vaultPath + '/', '') });
    } catch { continue; }
  }

  if (limit > 0) needsSummary.splice(limit);

  console.log(`Found ${needsSummary.length} notes without summaries`);
  const results = [];

  for (const note of needsSummary) {
    const title = note.fm.title || note.rel.split('/').pop().replace(/\.md$/, '');
    console.log(`Summarizing: ${note.rel}`);

    const result = await summarizeNote(title, note.body);
    if (!result.success) {
      console.log(`  Failed: ${result.error}`);
      results.push({ path: note.rel, status: 'error' });
      await delay(2000);
      continue;
    }

    console.log(`  → ${result.summary?.slice(0, 80)}...`);

    if (!dryRun) {
      const updatedFm = {
        ...note.fm,
        summary: result.summary,
        key_topics: result.key_topics,
      };
      const updated = writeNote(note.body, updatedFm);
      writeFileSync(note.filePath, updated);
    }

    results.push({ path: note.rel, status: dryRun ? 'dry-run' : 'summarized', summary: result.summary });
    await delay(2000);
  }

  return {
    summarized: results.filter(r => r.status === 'summarized').length,
    errors: results.filter(r => r.status === 'error').length,
    total: needsSummary.length,
    results,
  };
}
