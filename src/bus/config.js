import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

function readInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getBusHome() {
  return process.env.KB_BUS_HOME || join(homedir(), '.claude', 'bus');
}

export function getBusDbPath() {
  return process.env.KB_BUS_DB_PATH || join(getBusHome(), 'bus.db');
}

export function getBusRetentionMessages() {
  return readInt('KB_BUS_RETENTION_MESSAGES', 200);
}

export function getBusPollMs() {
  return readInt('KB_BUS_POLL_MS', 250);
}

export function getBusResourceLimit() {
  return readInt('KB_BUS_RESOURCE_LIMIT', 50);
}

export function ensureBusStorage() {
  mkdirSync(dirname(getBusDbPath()), { recursive: true });
}
