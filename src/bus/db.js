import Database from 'better-sqlite3';
import { ensureBusStorage, getBusDbPath } from './config.js';

let db = null;
let dbPath = null;

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS bus_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      sender TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message',
      body TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_bus_messages_channel_id
      ON bus_messages(channel, id);

    CREATE INDEX IF NOT EXISTS idx_bus_messages_created_at
      ON bus_messages(created_at);
  `);
}

export function getBusDb() {
  const nextPath = getBusDbPath();
  if (!db || dbPath !== nextPath) {
    closeBusDb();
    ensureBusStorage();
    db = new Database(nextPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    dbPath = nextPath;
  }
  return db;
}

export function closeBusDb() {
  if (db) {
    db.close();
    db = null;
    dbPath = null;
  }
}
