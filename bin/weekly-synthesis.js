#!/usr/bin/env node
// Weekly synthesis job — run via cron or manually
// Generates a synthesis prompt note that can be processed by an AI agent

import '../src/paths.js'; // loads .env from ~/.knowledge-base/.env
import { getRecentNotes, generateSynthesisPrompt, writeSynthesisNote } from '../src/synthesis/weekly-review.js';

import { homedir } from 'os';
import { join } from 'path';

const vaultPath = process.env.OBSIDIAN_VAULT_PATH || join(homedir(), 'obsidian-vault');
const notes = getRecentNotes(vaultPath, 7);

if (notes.length === 0) {
  console.log('No recent notes to synthesize');
  process.exit(0);
}

const prompt = generateSynthesisPrompt(notes);
const result = writeSynthesisNote(prompt, vaultPath);
console.log('Synthesis note created:', result.path);
