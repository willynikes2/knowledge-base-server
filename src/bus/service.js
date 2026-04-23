import { getBusDb } from './db.js';
import { getBusPollMs, getBusResourceLimit, getBusRetentionMessages } from './config.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseMetadata(metadataJson) {
  if (!metadataJson) return null;
  return JSON.parse(metadataJson);
}

function mapMessage(row) {
  return {
    id: row.id,
    channel: row.channel,
    sender: row.sender,
    kind: row.kind,
    body: row.body,
    metadata: parseMetadata(row.metadata_json),
    created_at: row.created_at,
  };
}

function requireText(value, name) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function clampLimit(limit, fallback = 50, max = 500) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function normalizeSince(since) {
  const value = Number(since);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export function sendBusMessage({ channel, sender, message, kind = 'message', metadata_json }) {
  const db = getBusDb();
  const cleanChannel = requireText(channel, 'channel');
  const cleanSender = requireText(sender, 'sender');
  const cleanMessage = requireText(message, 'message');
  const cleanKind = requireText(kind, 'kind');
  const metadata = metadata_json ? JSON.stringify(JSON.parse(metadata_json)) : null;

  const result = db.prepare(`
    INSERT INTO bus_messages (channel, sender, kind, body, metadata_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(cleanChannel, cleanSender, cleanKind, cleanMessage, metadata);

  pruneChannel(cleanChannel);
  return getMessageById(result.lastInsertRowid);
}

function pruneChannel(channel) {
  const keep = getBusRetentionMessages();
  const db = getBusDb();
  db.prepare(`
    DELETE FROM bus_messages
    WHERE channel = ?
      AND id NOT IN (
        SELECT id FROM bus_messages
        WHERE channel = ?
        ORDER BY id DESC
        LIMIT ?
      )
  `).run(channel, channel, keep);
}

export function getMessageById(id) {
  const row = getBusDb().prepare(`
    SELECT id, channel, sender, kind, body, metadata_json, created_at
    FROM bus_messages
    WHERE id = ?
  `).get(id);
  return row ? mapMessage(row) : null;
}

export function getBusInbox({ channel, since = 0, limit = 50 }) {
  const cleanChannel = requireText(channel, 'channel');
  const cursor = normalizeSince(since);
  const pageSize = clampLimit(limit);
  const db = getBusDb();

  const rows = db.prepare(`
    SELECT id, channel, sender, kind, body, metadata_json, created_at
    FROM bus_messages
    WHERE channel = ? AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(cleanChannel, cursor, pageSize);

  const messages = rows.map(mapMessage);
  const latest = db.prepare(`
    SELECT MAX(id) AS latest_id
    FROM bus_messages
    WHERE channel = ?
  `).get(cleanChannel);

  return {
    channel: cleanChannel,
    messages,
    count: messages.length,
    next_since: messages.at(-1)?.id ?? cursor,
    latest_id: latest?.latest_id ?? cursor,
  };
}

export async function waitForBusInbox({ channel, since = 0, timeout_ms = 30000, limit = 50 }) {
  const cleanChannel = requireText(channel, 'channel');
  const cursor = normalizeSince(since);
  const timeout = clampLimit(timeout_ms, 30000, 300000);
  const deadline = Date.now() + timeout;

  while (Date.now() <= deadline) {
    const inbox = getBusInbox({ channel: cleanChannel, since: cursor, limit });
    if (inbox.count > 0) {
      return { ...inbox, timed_out: false };
    }
    await sleep(getBusPollMs());
  }

  const latest = getBusInbox({ channel: cleanChannel, since: cursor, limit: 1 });
  return {
    channel: cleanChannel,
    messages: [],
    count: 0,
    next_since: cursor,
    latest_id: latest.latest_id,
    timed_out: true,
  };
}

export function readBusChannel(channel, limit = getBusResourceLimit()) {
  const cleanChannel = requireText(channel, 'channel');
  const db = getBusDb();
  const rows = db.prepare(`
    SELECT id, channel, sender, kind, body, metadata_json, created_at
    FROM bus_messages
    WHERE channel = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(cleanChannel, clampLimit(limit, getBusResourceLimit()));

  const messages = rows.reverse().map(mapMessage);
  return {
    channel: cleanChannel,
    messages,
    latest_id: messages.at(-1)?.id ?? 0,
  };
}

export function listBusChannels(limit = 100) {
  return getBusDb().prepare(`
    SELECT channel, MAX(id) AS latest_id, COUNT(*) AS message_count
    FROM bus_messages
    GROUP BY channel
    ORDER BY latest_id DESC
    LIMIT ?
  `).all(clampLimit(limit, 100, 500));
}
