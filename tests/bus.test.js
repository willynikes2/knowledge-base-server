import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { closeBusDb } from '../src/bus/db.js';
import { getBusInbox, sendBusMessage, waitForBusInbox } from '../src/bus/service.js';

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
});
