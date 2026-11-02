# CI and browser regression tests

Adapted from @Nuctori's CI/E2E proposal in #617 and #599. The performance
scanner, reverse reader, sidebar changes, and timing benchmarks are not included.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The script starts and stops its own Turbopack dev server on an available
loopback port. Run it in a checkout without an active dev server; Next.js
shares `.next/dev/lock` within a checkout. All fixtures are created before
startup in a temporary `PI_CODING_AGENT_DIR` and removed on completion.
No model credentials or existing Pi sessions are needed.

CI runs lint, type checking, and unit tests in one job. A separate job builds
the application in a clean checkout and runs the same browser tests with
`E2E_SERVER_MODE=start` against `next start`. Do not build in a checkout used
for development.

Coverage:

- A 5,000-message session opens with exactly the last 50 entries, bounded
  detail/context responses, and no browser errors.
- Desktop and mobile scrolling load two consecutive older pages. Each response
  has the expected IDs, no gaps or duplicates, and the messages appear once in
  the chat. A small session checks pagination through the root.
- Branch context follows the selected leaf and excludes the other branch.
- Markdown, code blocks, and real tool-call/tool-result blocks render.
- Chat width and font size persist, existing drafts resize, and short settings
  panels keep every language option reachable on desktop and mobile.
- Unknown sessions and paths outside the fixture project are rejected.
- A local extension checks dialog keyboard navigation, Esc cancellation,
  collapse/expand draft preservation, countdown display, and server-side expiry.

The independent prompt-suggester chain is a separate, opt-in acceptance test:

```sh
PI_PROMPT_SUGGESTER_PACKAGE=/absolute/path/to/reviewed/pi-prompt-suggester \
  node e2e/prompt-suggester-chain.test.mjs
```

Without the variable it uses the installed local package at
`~/.pi/agent/packages/pi-prompt-suggester`. It copies the reviewed package into its
isolated fixture HOME, registers it through the normal Pi Package mechanism, and uses
an offline local model fixture. It checks desktop and
mobile Ghost Text, acceptance, package inventory, and a package-only update followed
by a session reload without rebuilding or restarting Reader. It does not use a paid
model or alter the source package. The package’s declared test directories run first
against temporary links to the validation checkout’s dependencies; the links are
removed before Reader starts. The test records the independent package version.

`e2e/idle-session-send.test.mjs` uses the same independent package source and checks
a cold historical session with startup confirmation UI and a held auxiliary model.
The first input must be admitted and persisted exactly once, remain after reload,
and never require a warm resubmission. Run these two opt-in fixtures separately:
both own a Next dev process and must not compete for one checkout’s dev lock.

Model prompts, live model streaming, and agent execution are outside the main suite.
Failures save a screenshot, Playwright trace, and server log under
`test-results/e2e/`; CI uploads that directory. Open a trace with
`npx playwright show-trace test-results/e2e/trace.zip`.
