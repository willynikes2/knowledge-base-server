import 'dotenv/config';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

export const KB_DIR = join(homedir(), '.knowledge-base');
export const FILES_DIR = join(KB_DIR, 'files');
export const DB_PATH = join(KB_DIR, 'kb.db');
export const CONFIG_PATH = join(KB_DIR, 'config.json');
export const PID_PATH = join(KB_DIR, 'kb.pid');

mkdirSync(FILES_DIR, { recursive: true });
