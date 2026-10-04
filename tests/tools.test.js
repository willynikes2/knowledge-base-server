import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getToolDefinitions, getHttpToolDefinitions } from '../src/tools.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('tools', () => {
  it('exports an array of tool definitions', () => {
    const tools = getToolDefinitions();
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length >= 19);
  });

  it('each tool has name, description, schema, handler', () => {
    const tools = getToolDefinitions();
    for (const tool of tools) {
      assert.ok(typeof tool.name === 'string', `tool missing name`);
      assert.ok(typeof tool.description === 'string', `${tool.name} missing description`);
      assert.ok(tool.schema !== undefined, `${tool.name} missing schema`);
      assert.ok(typeof tool.handler === 'function', `${tool.name} missing handler`);
    }
  });

  it('includes all expected tool names', () => {
    const tools = getToolDefinitions();
    const names = tools.map(t => t.name);
    const expected = [
      'bus_send', 'bus_inbox', 'bus_wait',
      'kb_search', 'kb_list', 'kb_read', 'kb_ingest',
      'kb_write', 'kb_vault_status', 'kb_capture_youtube',
      'kb_capture_web', 'kb_capture_session', 'kb_capture_fix',
      'kb_search_smart', 'kb_promote', 'kb_synthesize',
      'kb_classify', 'kb_context', 'kb_safety_check'
    ];
    for (const name of expected) {
      assert.ok(names.includes(name), `missing tool: ${name}`);
    }
  });

  it('getHttpToolDefinitions excludes admin-only tools', () => {
    const httpTools = getHttpToolDefinitions();
    const names = httpTools.map(t => t.name);
    assert.ok(!names.includes('kb_classify'));
    assert.ok(!names.includes('kb_promote'));
    assert.ok(!names.includes('kb_synthesize'));
    assert.ok(!names.includes('kb_safety_check'));
    assert.ok(!names.includes('kb_capture_youtube'));
    assert.ok(!names.includes('kb_export'));
    assert.ok(!names.includes('kb_restore'));
    assert.ok(!names.includes('bus_send'));
    assert.ok(!names.includes('bus_inbox'));
    assert.ok(!names.includes('bus_wait'));
    // Should still include read + limited write tools
    assert.ok(names.includes('kb_search'));
    assert.ok(names.includes('kb_ingest'));
    assert.ok(names.includes('kb_write'));
  });

  it('MCP stdio tools/list serializes every tool schema', () => {
    const input = [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      '',
    ].join('\n');

    const result = spawnSync(process.execPath, ['bin/kb.js', 'mcp'], {
      cwd: PROJECT_ROOT,
      input,
      encoding: 'utf8',
      env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' },
    });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /_zod|InternalError/);

    const messages = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const toolsList = messages.find((message) => message.id === 2);

    assert.ok(toolsList, 'missing tools/list response');
    assert.ok(Array.isArray(toolsList.result.tools));
    assert.ok(toolsList.result.tools.some((tool) => tool.name === 'kb_export'));
  });

  it('kb_restore requires explicit yes=true for non-dry-run calls', async () => {
    const tool = getToolDefinitions().find(t => t.name === 'kb_restore');
    assert.ok(tool);
    const originalVault = process.env.OBSIDIAN_VAULT_PATH;
    process.env.OBSIDIAN_VAULT_PATH = '/tmp';
    try {
      const result = await tool.handler({
        bundle_path: '/tmp/nonexistent-bundle',
        dry_run: false,
        yes: false,
      });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /yes=true/);
    } finally {
      if (originalVault === undefined) {
        delete process.env.OBSIDIAN_VAULT_PATH;
      } else {
        process.env.OBSIDIAN_VAULT_PATH = originalVault;
      }
    }
  });

  it('kb_export and kb_restore reject paths outside the configured export root', async () => {
    const exportTool = getToolDefinitions().find(t => t.name === 'kb_export');
    const restoreTool = getToolDefinitions().find(t => t.name === 'kb_restore');
    assert.ok(exportTool);
    assert.ok(restoreTool);

    const originalVault = process.env.OBSIDIAN_VAULT_PATH;
    process.env.OBSIDIAN_VAULT_PATH = '/tmp';
    try {
      const exportResult = await exportTool.handler({
        output_path: '/etc/kb-export',
        dry_run: true,
      });
      assert.strictEqual(exportResult.isError, true);
      assert.match(exportResult.content[0].text, /Path must stay under/);

      const restoreResult = await restoreTool.handler({
        bundle_path: '/etc/kb-export',
        dry_run: true,
      });
      assert.strictEqual(restoreResult.isError, true);
      assert.match(restoreResult.content[0].text, /Path must stay under/);
    } finally {
      if (originalVault === undefined) {
        delete process.env.OBSIDIAN_VAULT_PATH;
      } else {
        process.env.OBSIDIAN_VAULT_PATH = originalVault;
      }
    }
  });

  it('kb_ingest_image rejects private image URLs before fetching', async () => {
    const tool = getToolDefinitions().find(t => t.name === 'kb_ingest_image');
    assert.ok(tool);

    const originalVault = process.env.OBSIDIAN_VAULT_PATH;
    process.env.OBSIDIAN_VAULT_PATH = '/tmp';
    try {
      const result = await tool.handler({
        title: 'Private URL',
        image_url: 'http://127.0.0.1/private.png',
      });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /private|loopback/i);
    } finally {
      if (originalVault === undefined) {
        delete process.env.OBSIDIAN_VAULT_PATH;
      } else {
        process.env.OBSIDIAN_VAULT_PATH = originalVault;
      }
    }
  });

  it('kb_ingest_image rejects IPv4-mapped/compatible and unspecified IPv6 URLs before fetching', async () => {
    const tool = getToolDefinitions().find(t => t.name === 'kb_ingest_image');
    assert.ok(tool);

    const originalVault = process.env.OBSIDIAN_VAULT_PATH;
    process.env.OBSIDIAN_VAULT_PATH = '/tmp';
    try {
      for (const imageUrl of [
        'http://[::ffff:127.0.0.1]/private.png',
        'http://[::ffff:7f00:1]/private.png',
        'http://[::ffff:a9fe:a9fe]/latest/meta-data',
        'http://[::ffff:10.0.0.1]/private.png',
        'http://[::127.0.0.1]/private.png',
        'http://[::]/private.png',
        'http://[64:ff9b::7f00:1]/private.png',
        'http://0.0.0.0/private.png',
        'http://100.64.0.1/private.png',
      ]) {
        const result = await tool.handler({ title: 'Private URL', image_url: imageUrl });
        assert.strictEqual(result.isError, true, `${imageUrl} should be rejected`);
        assert.match(result.content[0].text, /private|loopback/i, `${imageUrl} should be rejected as private`);
      }
    } finally {
      if (originalVault === undefined) {
        delete process.env.OBSIDIAN_VAULT_PATH;
      } else {
        process.env.OBSIDIAN_VAULT_PATH = originalVault;
      }
    }
  });

  it('kb_ingest_image enforces the documented base64 size limit', async () => {
    const tool = getToolDefinitions().find(t => t.name === 'kb_ingest_image');
    assert.ok(tool);

    const originalVault = process.env.OBSIDIAN_VAULT_PATH;
    process.env.OBSIDIAN_VAULT_PATH = '/tmp';
    try {
      const imageData = Buffer.alloc((50 * 1024) + 1, 1).toString('base64');
      const result = await tool.handler({
        title: 'Oversized Image',
        image_data: imageData,
        media_type: 'image/png',
      });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /50KB MCP limit/);
    } finally {
      if (originalVault === undefined) {
        delete process.env.OBSIDIAN_VAULT_PATH;
      } else {
        process.env.OBSIDIAN_VAULT_PATH = originalVault;
      }
    }
  });
});
