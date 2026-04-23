import { z } from 'zod';
import { getBusInbox, sendBusMessage, waitForBusInbox } from './service.js';

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(error) {
  return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
}

export function getBusToolDefinitions() {
  return [
    {
      name: 'bus_send',
      description: 'Send an append-only markdown message to a local cross-agent channel. Use this for Codex↔Claude↔Gemini handoffs, status updates, and task completion reports.',
      schema: {
        channel: z.string().describe('Free-form channel ID (e.g. ticket:PF-1884, session:1234, swarm:frontend)'),
        sender: z.string().describe('Sender label (e.g. codex, claude, gemini, deploy-watcher)'),
        message: z.string().describe('Markdown message body'),
        kind: z.string().optional().default('message').describe('Message kind (e.g. message, result, status, error, handoff)'),
        metadata_json: z.string().optional().describe('Optional JSON metadata string'),
      },
      handler: async ({ channel, sender, message, kind, metadata_json }) => {
        try {
          return ok(sendBusMessage({ channel, sender, message, kind, metadata_json }));
        } catch (error) {
          return fail(error);
        }
      },
    },

    {
      name: 'bus_inbox',
      description: 'Read messages from a local cross-agent channel after a cursor. Use the returned next_since as the next cursor.',
      schema: {
        channel: z.string().describe('Channel ID'),
        since: z.number().optional().default(0).describe('Return only messages with id greater than this cursor'),
        limit: z.number().optional().default(50).describe('Maximum number of messages to return'),
      },
      handler: async ({ channel, since, limit }) => {
        try {
          return ok(getBusInbox({ channel, since, limit }));
        } catch (error) {
          return fail(error);
        }
      },
    },

    {
      name: 'bus_wait',
      description: 'Long-poll a local cross-agent channel until a new message arrives or timeout elapses. Use this when the host cannot auto-wake on MCP resource updates.',
      schema: {
        channel: z.string().describe('Channel ID'),
        since: z.number().optional().default(0).describe('Wait for messages newer than this cursor'),
        timeout_ms: z.number().optional().default(30000).describe('Maximum wait time in milliseconds (max 300000)'),
        limit: z.number().optional().default(50).describe('Maximum number of messages to return'),
      },
      handler: async ({ channel, since, timeout_ms, limit }) => {
        try {
          return ok(await waitForBusInbox({ channel, since, timeout_ms, limit }));
        } catch (error) {
          return fail(error);
        }
      },
    },
  ];
}
