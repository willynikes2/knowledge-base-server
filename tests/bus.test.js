import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { closeBusDb } from '../src/bus/db.js';
import { getBusInbox, onBusMessage, sendBusMessage, waitForBusInbox } from '../src/bus/service.js';
import { diffBusChannelUris } from '../src/bus/notifier.js';
import { registerBusResources } from '../src/bus/resources.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const execFileAsync = promisify(execFile);
const tempDirs = [];

function makeBusHome() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-bus-test-'));
  tempDirs.push(dir);
  process.env.KB_BUS_HOME = dir;
  delete process.env.KB_BUS_DB_PATH;
  closeBusDb();
  return dir;
}

afterEach(() => {
  closeBusDb();
  delete process.env.KB_BUS_HOME;
  delete process.env.KB_BUS_DB_PATH;
  delete process.env.KB_BUS_RETENTION_MESSAGES;
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('message bus service', () => {
  it('sends and reads messages using cursor semantics', () => {
    makeBusHome();

    const first = sendBusMessage({
      channel: 'ticket:PF-1884',
      sender: 'codex',
      message: 'done',
      kind: 'result',
      metadata_json: JSON.stringify({ model: 'gpt-5.4' }),
    });
    sendBusMessage({
      channel: 'ticket:PF-1884',
      sender: 'claude',
      message: 'ack',
    });

    const inbox = getBusInbox({ channel: 'ticket:PF-1884', since: 0 });
    assert.strictEqual(inbox.count, 2);
    assert.strictEqual(inbox.messages[0].id, first.id);
    assert.deepStrictEqual(inbox.messages[0].metadata, { model: 'gpt-5.4' });

    const next = getBusInbox({ channel: 'ticket:PF-1884', since: first.id });
    assert.strictEqual(next.count, 1);
    assert.strictEqual(next.messages[0].body, 'ack');
  });

  it('waits for messages and times out cleanly', async () => {
    makeBusHome();

    const pending = waitForBusInbox({ channel: 'session:test', since: 0, timeout_ms: 1000 });
    setTimeout(() => {
      sendBusMessage({ channel: 'session:test', sender: 'watcher', message: 'ready' });
    }, 50);

    const found = await pending;
    assert.strictEqual(found.timed_out, false);
    assert.strictEqual(found.count, 1);
    assert.strictEqual(found.messages[0].body, 'ready');

    const timedOut = await waitForBusInbox({ channel: 'session:test', since: found.next_since, timeout_ms: 50 });
    assert.strictEqual(timedOut.timed_out, true);
    assert.strictEqual(timedOut.count, 0);
  });

  it('retains only the latest N messages per channel', () => {
    makeBusHome();
    process.env.KB_BUS_RETENTION_MESSAGES = '2';

    sendBusMessage({ channel: 'swarm:test', sender: 'a', message: 'one' });
    sendBusMessage({ channel: 'swarm:test', sender: 'b', message: 'two' });
    sendBusMessage({ channel: 'swarm:test', sender: 'c', message: 'three' });

    const inbox = getBusInbox({ channel: 'swarm:test', since: 0, limit: 10 });
    assert.strictEqual(inbox.count, 2);
    assert.deepStrictEqual(inbox.messages.map(msg => msg.body), ['two', 'three']);
  });

  it('CLI shim writes messages without MCP', async () => {
    const home = makeBusHome();

    await execFileAsync('node', [
      'bin/bus-send.js',
      'ticket:PF-1884',
      'report ready',
      '--sender',
      'codex',
      '--kind',
      'result',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, KB_BUS_HOME: home },
    });

    const inbox = getBusInbox({ channel: 'ticket:PF-1884', since: 0 });
    assert.strictEqual(inbox.count, 1);
    assert.strictEqual(inbox.messages[0].sender, 'codex');
    assert.strictEqual(inbox.messages[0].kind, 'result');
  });

  it('emits in-process message notifications', async () => {
    makeBusHome();

    const seen = [];
    const stop = onBusMessage(message => seen.push(message));
    try {
      sendBusMessage({ channel: 'ticket:PF-1884', sender: 'codex:test', message: 'hello' });
    } finally {
      stop();
    }

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].channel, 'ticket:PF-1884');
    assert.strictEqual(seen[0].body, 'hello');
  });
});

describe('bus notifier diffing', () => {
  it('returns URIs for channels whose latest id changed', () => {
    const previous = new Map([['ticket:PF-1884', 1], ['session:abc', 2]]);
    const next = new Map([['ticket:PF-1884', 2], ['session:abc', 2], ['swarm:test', 1]]);

    assert.deepStrictEqual(
      diffBusChannelUris(previous, next).sort(),
      ['bus://swarm%3Atest', 'bus://ticket%3APF-1884'],
    );
  });
});

describe('bus resources', () => {
  it('lists and reads channels with colons via valid URIs', async () => {
    makeBusHome();
    sendBusMessage({ channel: 'ticket:PF-1884', sender: 'codex', message: 'hello' });

    const server = new McpServer({ name: 'bus-test', version: '0.0.0' });
    registerBusResources(server);
    const client = new Client({ name: 'bus-test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const { resources } = await client.listResources();
      assert.strictEqual(resources.length, 1);
      assert.doesNotThrow(() => new URL(resources[0].uri));

      const read = await client.readResource({ uri: resources[0].uri });
      const payload = JSON.parse(read.contents[0].text);
      assert.strictEqual(payload.channel, 'ticket:PF-1884');
      assert.strictEqual(payload.messages[0].body, 'hello');
      assert.strictEqual(read.contents[0].uri, resources[0].uri);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
