#!/usr/bin/env node

import 'dotenv/config';
import { runBusInboxCli } from '../src/bus/cli.js';

runBusInboxCli(process.argv.slice(2)).catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
