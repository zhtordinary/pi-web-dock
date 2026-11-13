# reader-mcp

A dependency-free stdio [MCP](https://modelcontextprotocol.io) server that lets MCP clients read Pi Web Dock sessions and request explicit, confirmed session-control actions. It ships inside the `@zhtordinary/pi-web-dock` npm package and needs only Node.js 22.19.0 or newer.

## Running

Point an MCP client at `server.mjs` from an installed `@zhtordinary/pi-web-dock` package and tell it where Pi Web Dock is listening:

```json
{
  "mcpServers": {
    "pi-web-dock": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/node_modules/@zhtordinary/pi-web-dock/packages/reader-mcp/server.mjs"],
      "env": { "PI_WEB_READER_URL": "http://127.0.0.1:30141" }
    }
  }
}
```

For a global install, `npm root -g` prints the `node_modules` directory. `127.0.0.1` means the machine the MCP client runs on; to reach another machine, use an address that machine's Pi Web Dock is reachable at. The server writes only JSON-RPC to stdout.

| Environment variable | Purpose |
| --- | --- |
| `PI_WEB_READER_URL` | Base URL of a running Pi Web Dock. Enables live activity, runtime state, and session control. |
| `PI_WEB_READER_DATA_ROOT` | Read session files directly from a pi agent directory instead. Storage-only: runtime state is reported as unknown and control is unavailable. |
| `PI_WEB_READER_DEVICE_NAME` | Display name for the local device in results (default `local`). |

The server does not add authentication of its own; it calls the same HTTP API as the browser. Keep Pi Web Dock on loopback, or behind a trusted proxy, when a client connects to it.

## Capabilities

- Tools: `reader_list_sessions`, `reader_get_session_metadata`, `reader_read_tail`, `reader_read_live_events`, `reader_get_stream_diagnostics`, `reader_session_control`, `reader_read_control_plane`, `reader_write_control_plane`, `reader_get_control_plane_receipt`, and `reader_get_session_control_receipt`.
- `reader_get_stream_diagnostics` is read-only and returns only in-process connection counters for an exact device. It excludes IP, User-Agent, request metadata, and event content, and uses Reader's `/api/remote` proxy for remote devices.
- Resources: `reader://ui-requests/{deviceId}/{sessionId}` exposes pending extension UI requests; subscribed clients receive `notifications/resources/updated`. Tool-only clients can use `reader_read_live_events` with `wait_ui_requests` for a bounded wait.
- Every result carries `schemaVersion`, `observedAt`, and explicit coverage and freshness fields.
- Control is dry-run by default. A real write needs `confirm`, a `confirmationReason`, and an `idempotencyKey`, and Pi Web Dock still applies its own authorization checks. The server never retries a write whose outcome is unknown.
- Protocol version `2025-11-25`; other requested versions are negotiated to it.

## Tests

`npm test` in this directory runs the package tests; the repository's root `npm test` includes them.
