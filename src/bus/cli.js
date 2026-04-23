import { getBusInbox, sendBusMessage, waitForBusInbox } from './service.js';

function readFlag(args, name, fallback = undefined) {
  const index = args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return fallback;
  const arg = args[index];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  return args[index + 1] ?? fallback;
}

function removeFlags(args, names) {
  const output = [];
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    const flag = names.find(name => current === name || current.startsWith(`${name}=`));
    if (!flag) {
      output.push(current);
      continue;
    }
    if (current === flag) i += 1;
  }
  return output;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export async function runBusSendCli(args) {
  const sender = readFlag(args, '--sender', process.env.MINO_BUS_SENDER || process.env.USER || 'cli');
  const kind = readFlag(args, '--kind', 'message');
  const metadata_json = readFlag(args, '--metadata');
  const positional = removeFlags(args, ['--sender', '--kind', '--metadata']);
  const [channel, ...messageParts] = positional;
  const message = messageParts.join(' ').trim();

  if (!channel || !message) {
    console.error('Usage: bus-send <channel> <message> [--sender <name>] [--kind <kind>] [--metadata <json>]');
    process.exit(1);
  }

  printJson(sendBusMessage({ channel, sender, message, kind, metadata_json }));
}

export async function runBusInboxCli(args) {
  const since = readFlag(args, '--since', '0');
  const limit = readFlag(args, '--limit', '50');
  const positional = removeFlags(args, ['--since', '--limit']);
  const [channel] = positional;

  if (!channel) {
    console.error('Usage: bus-inbox <channel> [--since <cursor>] [--limit <n>]');
    process.exit(1);
  }

  printJson(getBusInbox({ channel, since: Number(since), limit: Number(limit) }));
}

export async function runBusWaitCli(args) {
  const since = readFlag(args, '--since', '0');
  const limit = readFlag(args, '--limit', '50');
  const timeout_ms = readFlag(args, '--timeout-ms', '30000');
  const positional = removeFlags(args, ['--since', '--limit', '--timeout-ms']);
  const [channel] = positional;

  if (!channel) {
    console.error('Usage: bus-wait <channel> [--since <cursor>] [--timeout-ms <ms>] [--limit <n>]');
    process.exit(1);
  }

  printJson(await waitForBusInbox({ channel, since: Number(since), timeout_ms: Number(timeout_ms), limit: Number(limit) }));
}
