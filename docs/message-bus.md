# Local message bus

The knowledge-base MCP server now includes a **local-only message bus** for agent-to-agent coordination across Claude Code, Codex, Gemini, and shell scripts.

## What ships in V1

- MCP tools: `bus_send`, `bus_inbox`, `bus_wait`
- MCP resource template: `bus://{channel}`
- CLI shims: `bus-send`, `bus-inbox`, `bus-wait`
- Shared append-only SQLite storage at `~/.claude/bus/bus.db`

Because this is an extension of `kb mcp`, you do **not** need a second MCP server if KB is already registered. Any client already pointed at `kb mcp` gets the bus tools automatically on next restart.

Run `kb register` to update local Claude/Codex/Gemini MCP configs in one shot, then restart the sessions that should gain `bus_send`.

## Channel naming

Use free-form channel IDs with stable prefixes:

- `ticket:PF-1884`
- `session:3d74f5b1`
- `swarm:frontend-refactor`
- `deploy:eva-sandbox`

## Recommended flow

### From an external script / Codex shell

```bash
bus-send ticket:PF-1884 "Implementation finished. Tests passed." \
  --sender codex \
  --kind result \
  --metadata '{"model":"gpt-5.4","branch":"uttam/pf-1884-message-bus"}'
```

### From an MCP client

- Send: `bus_send(channel, sender, message, kind?, metadata_json?)`
- Poll: `bus_inbox(channel, since?)`
- Long-poll: `bus_wait(channel, since?, timeout_ms?)`

Use the returned `next_since` as the next cursor.

## Resources

`bus://ticket:PF-1884` returns the latest messages for that channel as JSON.

If your MCP host supports resource subscriptions, you can subscribe to that URI. In practice, **V1 should still assume poll or long-poll**:

- external `bus-send` writes to SQLite directly
- a running stdio MCP child process cannot be woken by that external process
- `bus_wait` is the reliable wakeup primitive today

## Storage / retention

- DB path: `~/.claude/bus/bus.db`
- Retention: last `KB_BUS_RETENTION_MESSAGES` per channel (default `200`)
- Poll interval for `bus_wait`: `KB_BUS_POLL_MS` (default `250`)

## Scope

V1 is intentionally:

- local only
- append only
- opaque markdown message bodies
- no auth beyond local machine trust
- no cross-machine delivery
