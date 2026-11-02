# Contributing to Pi Web Dock

Thanks for helping. Pi Web Dock is a browser workbench for the [pi coding agent](https://github.com/earendil-works/pi). It reads and writes the same agent directory as the pi CLI and runs sessions through pi's SDK, so a session behaves the same in pi and in Pi Web Dock.

## How changes reach this repository

This repository publishes reviewed snapshots of the maintainer's source tree. Pull requests are reviewed and discussed here as usual, but they are not merged with the GitHub merge button:

1. A maintainer reviews the pull request and the CI results.
2. Accepted changes are applied to the maintainer's tree, verified in a disposable, network-isolated virtual machine, and run through the full test suite and production build.
3. The next snapshot commit carries the change with a `Co-authored-by` trailer for each contributor, and the pull request is closed with a link to it.

Changes may be adjusted while they are applied; the closing comment says what changed and why.

## Scope

Good fits:

- Bug fixes with reproduction steps that fix the cause rather than the symptom.
- Better rendering of what pi already produces: tool output, Markdown, extension UI.
- Reading, navigation, and activity features for long or parallel sessions.
- Fixes for mobile, PWA, Safari, and Linux or macOS differences.
- Performance work with before-and-after measurements.

Usually declined:

- Changes to what pi itself does — the system prompt, tool behavior, compaction, or what gets written to session files. Propose these upstream in pi.
- Features that work better as a pi extension, so they run in both pi and the browser.
- Patching pi's private methods or internal state.
- New visual themes or color tokens beyond the existing ones in `app/globals.css`.

For a new feature, open an issue first that describes the use case.

## Before you open a pull request

- Keep it to one change per pull request.
- For a bug fix, explain how to reproduce it and why the change fixes the cause.
- Run the checks: `npm test`, `npx tsc --noEmit`, and `npm run lint`. Run `npm run build` only in a separate clean checkout, because a production build replaces the development `.next/` output.
- Translate new UI text in `en`, `zh-CN`, and `zh-TW` ([Internationalization](./docs/i18n.md)).
- Read the topic notes in `docs/agents/` for the areas you change.
- Avoid new runtime dependencies. If one is needed, say why.
- Never include credentials, session files, or personal paths in code, tests, or screenshots. Tests must use temporary directories and synthetic data.

## Continuous integration

Pull request CI runs on GitHub-hosted runners with read-only repository permissions and no secrets. It does not publish anything. Changes to `.github/workflows/` are reviewed with extra care and must keep actions pinned to full commit SHAs.

## Security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the [MIT License](./LICENSE) of this project.
