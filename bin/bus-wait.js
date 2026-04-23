#!/usr/bin/env node

import 'dotenv/config';
import { runBusWaitCli } from '../src/bus/cli.js';

runBusWaitCli(process.argv.slice(2)).catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
