# Isolate project command environments from the web host

Pi Web sanitizes the environment of its built-in project shells instead of exposing the Next.js host runtime wholesale. The agent `bash` tool and direct user shell commands remove `PORT`, `NODE_ENV`, `NEXT_*`, and the `PI_WEB_PASSWORD` login secret while preserving the SDK-managed PATH, Pi session metadata, and all other inherited values; explicit variables set by a project command still take effect. The built-in terminal keeps the host environment but also omits `PI_WEB_PASSWORD`. Third-party extensions retain control of their own tools and subprocesses so existing overrides and remote execution integrations are not intercepted.


## Structured argv consumers

持续等待 worker 的结构化 argv 入口不是另一套环境边界：`bin/project-command-env.cjs` 与 `lib/project-command-env.ts` 使用同一规则，spawn 前删除 `PORT`、`NODE_ENV`、`NEXT_*`、`PI_WEB_PASSWORD`，保留 `PATH`、Pi session metadata 和项目变量。Host Runtime 环境不会作为 task stdout/result/state 持久快照；该规则同时适用于 CJS worker 和 TypeScript project-command shell。
