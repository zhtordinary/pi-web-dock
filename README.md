# Pi Web Dock

[中文说明](./docs/README.zh-CN.md)

Pi Web Dock is a browser workbench for the [pi coding agent](https://github.com/earendil-works/pi). It is a community distribution of [Pi Web](https://github.com/agegr/pi-web) that keeps Pi Web's local-first model — the same `~/.pi/agent` configuration and session files as pi — and adds tools for reading long sessions, following agents across machines, and working with Git worktrees.

Pi Web Dock is not affiliated with the pi or Pi Web projects. The interface is still labelled "Pi Web".

## Highlights

- **Long-session reading**: one message list with turn-by-turn progressive loading, a reading mode, and jump-to-latest preferences.
- **Talk Map**: lay out sessions as cards grouped by subproject, and drag them between subprojects.
- **Answer details**: per-turn cache hit rate and a breakdown of the tools, skills, and plugins each answer actually used.
- **Activity across devices**: add other Pi Web Dock instances as peers to see which sessions are running, waiting, or finished on each machine, and open remote sessions in place.
- **Git worktrees**: create, rename, and remove worktrees from the UI; each session keeps running in its recorded working directory.
- **Files**: project file browser with Git status and diffs, inline audio/video for linked media, and previews for Markdown, images, PDFs, and DOCX.
- **Status sounds**: optional completion, error, and waiting sounds.
- **MCP adapter**: `packages/reader-mcp` exposes sessions and session control to MCP clients over stdio.
- Everything from Pi Web: session management and branching, models and provider login, plugins, skills, subagents, and an English / Simplified Chinese / Traditional Chinese UI.

## Requirements

- Node.js 26.4.0 or newer (`node --version`). Older releases ship a `node:sqlite` that truncates text at NUL characters, which the durable receipt store relies on.
- macOS or Linux. Windows is not verified yet.
- pi's agent directory (`~/.pi/agent` by default). If no model provider is configured, open the **Models** panel to sign in or add an API key.

## Quick start

Install the CLI from npm and start it:

```bash
npm install -g @zhtordinary/pi-web-dock
pi-web-dock
```

The CLI opens a browser when the server is ready. Otherwise open <http://127.0.0.1:30141>. Pi Web Dock listens only on `127.0.0.1` by default.

To update, stop the server, run `npm install -g @zhtordinary/pi-web-dock@latest`, then start it again.

### From source

```bash
git clone https://github.com/zhtordinary/pi-web-dock.git
cd pi-web-dock
npm ci
npm run build
node bin/pi-web.js
```

To update a source checkout, stop the server, run `git pull --ff-only`, then repeat `npm ci` and `npm run build`.

## Configuration

Command-line options override the corresponding environment variables. Run `pi-web-dock --help` (or `node bin/pi-web.js --help` in a source checkout) to print the options.

| Option or environment variable | Purpose | Default |
| --- | --- | --- |
| `--port <port>`, `-p <port>`, or `PORT` | Server port | `30141` |
| `--hostname <host>`, `-H <host>`, or `PI_WEB_HOSTNAME` | Bind hostname | `127.0.0.1` |
| `--no-open` or `PI_WEB_NO_OPEN=1` | Do not open a browser automatically | Browser opens |
| `PI_WEB_PASSWORD` | Enable browser password login and API Basic Auth | Authentication disabled |
| `PI_WEB_ALLOWED_HOSTS` | Additional exact proxy or custom hostnames, comma-separated | Unset |
| `PI_WEB_SKIP_VERSION_CHECK=1` | Disable update checks against the npm registry | Unset |
| `PI_WEB_IDLE_TIMEOUT_MS` | Session idle timeout in milliseconds; `0` disables idle shutdown | `600000` |
| `PI_CODING_AGENT_DIR` | pi agent directory to read sessions, models, and settings from | `~/.pi/agent` |

Ports `30142`–`30144` are reserved for the maintainer's managed release channels; use another port for additional instances.

### Remote access

Binding to a non-loopback address exposes an agent that can run commands on your machine. On a trusted network, require a long random password:

```bash
PI_WEB_PASSWORD='a-long-random-password' pi-web-dock --hostname 0.0.0.0
```

Password authentication does not encrypt traffic. Do not expose Pi Web Dock over plain HTTP to the internet; put it behind HTTPS on a trusted reverse proxy or VPN, and add the proxy's hostname to `PI_WEB_ALLOWED_HOSTS`.

Server-side model and API requests honor `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`.

### Optional integrations

These features stay off until you install or configure them; everything else works without them.

- **Session cost estimates**: set `PI_CONVERSATION_COST_SCRIPT` to a Python pricing adapter that exposes `price_usages(...)` on top of [genai-prices](https://github.com/pydantic/genai-prices). Without it, costs that the provider did not report are shown as unavailable.
- **Remote Claude provider**: install a `pi-remote-claude` pi package under `<agent dir>/packages/`. Without it, the `claude-remote` provider is not offered.
- **Peers**: add another instance's URL from the activity panel. Server-to-server peer requests do not forward browser credentials, so a peer protected by `PI_WEB_PASSWORD` cannot currently be aggregated. Use peers only between instances you control on a trusted, access-restricted network; do not expose an unauthenticated instance to the internet.

## Data and access

- Sessions are pi's own JSONL files under `<agent dir>/sessions/`; Pi Web Dock reads and writes them through the pi SDK.
- The file interface has separate read and write roots, configurable under **Settings → General → File access**. On first use, it includes known project and session roots, the configured agent and custom prompts locations, `~/.pi`, `~/Sync`, and `~/.agents/skills`. The policy is stored in `~/.config/pi-web-reader/file-permissions.json` by default. This policy does not sandbox agent tools, terminals, extensions, or external apps.
- Interface state (favorites, hidden sessions, peers, and similar settings) is stored in small JSON files under `~/.config/pi-web-reader/` and the pi agent directory.

## Development

```bash
npm ci
npm run dev      # development server on 127.0.0.1:30141
npm test         # unit and integration tests
npm run lint
npm run build    # production build into .next/
```

Browser tests use Playwright: `npx playwright install chromium`, then `npm run test:e2e`. See [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## Relationship to Pi Web

Pi Web Dock started from Pi Web by agegr and selectively adopts upstream releases; its version number tracks the Pi Web release it is based on. Report issues with this distribution here rather than upstream.

## License

[MIT](./LICENSE). Bundled third-party assets keep their own licenses: Catppuccin icons (MIT, `public/icons/catppuccin/`), Noto Sans Mono (SIL OFL 1.1), Symbols Nerd Font (MIT), and provider icons from `@lobehub/icons` (MIT). The application icons are based on the pi logo and belong to the pi project.
