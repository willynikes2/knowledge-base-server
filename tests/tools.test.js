import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getToolDefinitions, getHttpToolDefinitions } from '../src/tools.js';

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
    assert.ok(!names.includes('bus_send'));
    assert.ok(!names.includes('bus_inbox'));
    assert.ok(!names.includes('bus_wait'));
    // Should still include read + limited write tools
    assert.ok(names.includes('kb_search'));
    assert.ok(names.includes('kb_ingest'));
    assert.ok(names.includes('kb_write'));
  });
});
