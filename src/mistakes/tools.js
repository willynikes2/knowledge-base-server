// src/mistakes/tools.js — MCP tools: record a mistake by hand, and fetch the known pitfalls for a task.
import { z } from 'zod';
import { recordMistake } from './store.js';
import { mirrorMistake } from './mirror.js';
import { patternsFor } from './delivery.js';
import { vaultPath } from './patterns.js';

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (error) => ({ content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true });

export function getMistakeToolDefinitions() {
  return [
    {
      name: 'kb_mistake_record',
      description: 'Record one mistake that a reviewer, a test or the operator caught in an agent\'s work, with its fix. Use it right after the fix is committed. Records are append-only; to correct one, record a new one with `supersedes`.',
      schema: {
        project: z.string().describe('Project name, e.g. browser-agent-demo'),
        task: z.string().describe('The task the mistake was made in, e.g. "T4 Run manager"'),
        finding: z.string().describe('What was wrong, in the reviewer\'s own words'),
        caught_by: z.string().describe('"review", "review:<model>", "test" or "operator"'),
        client_ok: z.boolean().describe('true only when the code owner allows keeping this record (always true for the operator\'s own projects)'),
        source: z.enum(['swarm', 'sdd', 'factory', 'manual', 'seed']).optional().default('manual'),
        model: z.string().optional().describe('The model that made the mistake'),
        file: z.string().optional().describe('File the mistake was in'),
        line: z.number().optional().describe('Line number'),
        fix_commit: z.string().optional().describe('Commit that fixed it (7-40 hex characters). Without it the record is weak evidence'),
        fix_diff: z.string().optional().describe('The fix as a diff; kept up to 4 KB, secrets redacted'),
        guard_test: z.string().optional().describe('The test that now guards against it'),
        tags: z.array(z.string()).optional().describe('2-4 topic words, e.g. ["error-handling", "fallback"]'),
        task_text_ref: z.string().optional().describe('Where the task text lives, e.g. docs/plans/x.md#task-4'),
        supersedes: z.string().optional().describe('Id of an earlier record this one corrects'),
        key: z.string().optional().describe('A stable key; a second record with the same key is not written'),
      },
      handler: async (args) => {
        try { return ok(recordMistake({ ...args, source: args.source ?? 'manual' }, { mirror: mirrorMistake })); } catch (error) { return fail(error); }
      },
    },

    {
      name: 'kb_patterns_for',
      description: 'Get at most 3 approved "known pitfalls" that match a task: mistakes earlier reviews caught on similar work, each with the rule to follow and a correct example. Call it before starting a task and put the returned markdown in the task brief. Returns nothing when no pattern matches.',
      schema: {
        task_text: z.string().describe('The task title and description'),
        files: z.array(z.string()).optional().default([]).describe('Files the task will touch'),
        run: z.string().optional().describe('Run or build name, for the delivery log'),
        task: z.string().optional().describe('Task id, for the delivery log'),
      },
      handler: async ({ task_text, files, run, task }) => {
        try { return ok(patternsFor({ task_text, files, run: run ?? null, task: task ?? null }, { vault: vaultPath() })); } catch (error) { return fail(error); }
      },
    },
  ];
}
