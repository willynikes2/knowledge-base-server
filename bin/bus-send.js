#!/usr/bin/env node

import 'dotenv/config';
import { runBusSendCli } from '../src/bus/cli.js';

runBusSendCli(process.argv.slice(2)).catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
