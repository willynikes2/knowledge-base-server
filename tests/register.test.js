import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getAgentConfigPath,
  KB_ENTRYPOINT_PATH,
  parseRegisterArgs,
  registerAgents,
} from '../src/cli/mcp-register.js';

const tempDirs = [];

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-register-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('MCP registration', () => {
  it('defaults to all supported agents', () => {
    assert.deepStrictEqual(parseRegisterArgs([]), ['claude', 'codex', 'gemini']);
  });

  it('parses an explicit agent subset', () => {
    assert.deepStrictEqual(parseRegisterArgs(['--agents=claude,codex,claude']), ['claude', 'codex']);
  });

  it('rejects unsupported agents', () => {
    assert.throws(() => parseRegisterArgs(['--agents=claude,foo']), /Unsupported agent/);
  });

  it('writes config files for selected agents', () => {
    const homeDir = makeHome();
    const results = registerAgents(['claude', 'codex'], homeDir);

    assert.strictEqual(results.length, 2);
    assert.ok(existsSync(getAgentConfigPath('claude', homeDir)));
    assert.ok(existsSync(getAgentConfigPath('codex', homeDir)));
    assert.ok(!existsSync(getAgentConfigPath('gemini', homeDir)));

    const claudeConfig = JSON.parse(readFileSync(getAgentConfigPath('claude', homeDir), 'utf-8'));
    const codexConfig = JSON.parse(readFileSync(getAgentConfigPath('codex', homeDir), 'utf-8'));

    assert.deepStrictEqual(claudeConfig.mcpServers['knowledge-base'], {
      command: process.execPath,
      args: [KB_ENTRYPOINT_PATH, 'mcp'],
    });
    assert.deepStrictEqual(codexConfig.mcpServers['knowledge-base'], {
      command: process.execPath,
      args: [KB_ENTRYPOINT_PATH, 'mcp'],
    });
  });
});
