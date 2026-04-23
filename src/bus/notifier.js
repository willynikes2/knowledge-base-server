import { existsSync, watch } from 'fs';
import { dirname, basename } from 'path';
import { getBusDbPath } from './config.js';
import { listBusChannels, onBusMessage } from './service.js';

function toStateMap(channels) {
  return new Map(channels.map(channel => [channel.channel, Number(channel.latest_id) || 0]));
}

export function diffBusChannelUris(previous, next) {
  const uris = [];
  for (const [channel, latestId] of next.entries()) {
    if (previous.get(channel) !== latestId) {
      uris.push(`bus://${channel}`);
    }
  }
  return uris;
}

function debounce(fn, delayMs) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn().catch?.(() => {});
    }, delayMs);
    timer.unref?.();
  };
}

async function sendResourceUpdated(mcpServer, uri) {
  if (!mcpServer.isConnected()) return;
  await mcpServer.server.sendResourceUpdated({ uri });
}

export function startBusPushNotifier(mcpServer) {
  let previous = toStateMap(listBusChannels(500));
  const dbPath = getBusDbPath();
  const watchedDir = dirname(dbPath);
  const watchedNames = new Set([
    basename(dbPath),
    `${basename(dbPath)}-wal`,
    `${basename(dbPath)}-shm`,
  ]);

  const flush = async () => {
    const next = toStateMap(listBusChannels(500));
    const changedUris = diffBusChannelUris(previous, next);
    previous = next;
    await Promise.all(changedUris.map(uri => sendResourceUpdated(mcpServer, uri)));
  };

  const flushSoon = debounce(flush, 25);
  const stopLocalSubscription = onBusMessage(({ channel }) => {
    previous.set(channel, Number(previous.get(channel) || 0) + 1);
    sendResourceUpdated(mcpServer, `bus://${channel}`).catch(() => {});
  });

  let watcher = null;
  if (existsSync(watchedDir)) {
    try {
      watcher = watch(watchedDir, (_eventType, filename) => {
        if (!filename || watchedNames.has(String(filename))) {
          flushSoon();
        }
      });
    } catch {
      watcher = null;
    }
  }

  return () => {
    stopLocalSubscription();
    watcher?.close();
  };
}
