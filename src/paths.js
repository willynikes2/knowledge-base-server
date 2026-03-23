import { config } from 'dotenv';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

export const KB_DIR = join(homedir(), '.knowledge-base');
export const FILES_DIR = join(KB_DIR, 'files');
export const DB_PATH = join(KB_DIR, 'kb.db');
export const CONFIG_PATH = join(KB_DIR, 'config.json');
export const PID_PATH = join(KB_DIR, 'kb.pid');
export const ENV_PATH = join(KB_DIR, '.env');

mkdirSync(FILES_DIR, { recursive: true });

// Load .env from KB_DIR — the canonical config location.
// No CWD fallback: CWD is unreliable (could be $HOME via systemd, /tmp, or npx cache).
if (existsSync(ENV_PATH)) {
  config({ path: ENV_PATH });
}
