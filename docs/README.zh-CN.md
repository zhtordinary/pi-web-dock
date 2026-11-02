# Pi Web Dock

[English](../README.md)

Pi Web Dock 是 [pi coding agent](https://github.com/earendil-works/pi) 的浏览器工作台，基于 [Pi Web](https://github.com/agegr/pi-web) 的社区发行版。它沿用 Pi Web 的本地优先模式：与 pi 共用 `~/.pi/agent` 的配置和会话文件；在此基础上增加了长会话阅读、跨设备跟进智能体和 Git 工作树相关的功能。

Pi Web Dock 与 pi、Pi Web 官方项目无隶属关系。界面上仍显示 “Pi Web”。

## 主要功能

- **长会话阅读**：单一消息列表、按轮渐进加载、阅读模式、“定位最新”偏好。
- **Talk Map**：把会话按子项目排成卡片，可在子项目之间拖动。
- **回答详情**：每轮的缓存命中率，以及这一轮实际调用的工具、Skill 和插件。
- **跨设备活动**：把其他 Pi Web Dock 实例加为对端，查看各台机器上正在运行、等待输入或已完成的会话，并就地打开远端会话。
- **Git 工作树**：在界面里新建、重命名、删除工作树；会话始终在其记录的工作目录中运行。
- **文件**：带 Git 状态和差异的项目文件浏览器；链接的音视频可内联播放；支持 Markdown、图片、PDF、DOCX 预览。
- **状态提示音**：可选的完成、出错、等待提示音。
- **MCP 适配器**：`packages/reader-mcp` 通过 stdio 向 MCP 客户端提供会话读取与会话控制。
- 保留 Pi Web 的全部能力：会话管理与分支、模型与 Provider 登录、插件、Skill、子智能体，以及英文、简体中文、繁体中文界面。

## 运行要求

- Node.js 26.4.0 或更新版本（`node --version`）。更早版本自带的 `node:sqlite` 会在 NUL 字符处截断文本，而持久回执存储依赖它。
- macOS 或 Linux。Windows 尚未验证。
- pi 的 agent 目录（默认 `~/.pi/agent`）。还没有配置模型时，打开 **Models** 面板登录或填写 API Key。

## 快速开始

```bash
git clone https://github.com/zhtordinary/pi-web-dock.git
cd pi-web-dock
npm ci
npm run build
node bin/pi-web.js
```

服务就绪后会自动打开浏览器；没有打开时访问 <http://127.0.0.1:30141>。默认只监听 `127.0.0.1`。

更新时先停止服务，执行 `git pull --ff-only`，再执行 `npm ci` 和 `npm run build`。

## 配置

命令行参数优先于对应的环境变量，`node bin/pi-web.js --help` 可查看全部参数。

| 参数或环境变量 | 作用 | 默认值 |
| --- | --- | --- |
| `--port <port>`、`-p <port>` 或 `PORT` | 服务端口 | `30141` |
| `--hostname <host>`、`-H <host>` 或 `PI_WEB_HOSTNAME` | 监听地址 | `127.0.0.1` |
| `--no-open` 或 `PI_WEB_NO_OPEN=1` | 不自动打开浏览器 | 自动打开 |
| `PI_WEB_PASSWORD` | 启用浏览器密码登录和 API Basic Auth | 不启用 |
| `PI_WEB_ALLOWED_HOSTS` | 额外允许的反向代理或自定义主机名，逗号分隔 | 未设置 |
| `PI_WEB_SKIP_VERSION_CHECK=1` | 关闭对 npm 的更新检查 | 未设置 |
| `PI_WEB_IDLE_TIMEOUT_MS` | 会话空闲超时（毫秒），`0` 表示不因空闲关闭 | `600000` |
| `PI_CODING_AGENT_DIR` | 读取会话、模型和设置的 pi agent 目录 | `~/.pi/agent` |

`30142`–`30144` 端口保留给维护者的受管发布通道，多开实例请用其他端口。

### 远程访问

监听非回环地址等于把一个能在本机执行命令的智能体暴露出去。只在可信网络中这样做，并设置足够长的随机密码：

```bash
PI_WEB_PASSWORD='a-long-random-password' node bin/pi-web.js --hostname 0.0.0.0
```

密码认证不会加密流量。不要通过明文 HTTP 暴露到公网；请放在可信反向代理的 HTTPS 或 VPN 之后，并把代理使用的主机名加入 `PI_WEB_ALLOWED_HOSTS`。服务端的模型和 API 请求遵循 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`。

### 可选集成

以下功能在安装或配置之前保持关闭，其他功能不依赖它们。

- **会话费用估算**：把 `PI_CONVERSATION_COST_SCRIPT` 指向一个基于 [genai-prices](https://github.com/pydantic/genai-prices)、提供 `price_usages(...)` 的 Python 计价适配脚本。未配置时，Provider 没有直接给出的费用显示为“不可用”。
- **远程 Claude Provider**：在 `<agent 目录>/packages/` 下安装 `pi-remote-claude` pi 包；未安装时不提供 `claude-remote` Provider。
- **对端设备**：在活动面板里填写另一个实例的地址。服务间的对端请求不会转发浏览器凭据，因此目前无法聚合受 `PI_WEB_PASSWORD` 保护的对端。只在受访问控制的可信网络中连接自己管理的实例，不要把未认证的实例暴露到公网。

## 数据与访问范围

- 会话就是 pi 自己在 `<agent 目录>/sessions/` 下的 JSONL 文件，Pi Web Dock 通过 pi SDK 读写。
- 文件界面的读写路径分别配置，在**设置 → 常规 → 文件访问权限**中管理。首次使用时，默认包括已知的项目和会话根目录、已配置的 agent 和自定义提示文件位置，以及 `~/.pi`、`~/Sync`、`~/.agents/skills`。配置默认保存在 `~/.config/pi-web-reader/file-permissions.json`。此配置不是操作系统沙箱，不限制 agent 工具、终端、扩展或外部应用。
- 收藏、隐藏、对端等界面状态保存在 `~/.config/pi-web-reader/` 和 pi agent 目录下的小型 JSON 文件中。

## 开发

```bash
npm ci
npm run dev      # 开发服务器，127.0.0.1:30141
npm test         # 单元与集成测试
npm run lint
npm run build    # 生产构建到 .next/
```

浏览器测试使用 Playwright：先执行 `npx playwright install chromium`，再运行 `npm run test:e2e`。提交 PR 前请阅读 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 与 Pi Web 的关系

Pi Web Dock 源自 agegr 的 Pi Web，并有选择地吸收上游版本；版本号跟随所基于的 Pi Web 版本。本发行版的问题请在本仓库反馈，不要提到上游。

## 许可

[MIT](../LICENSE)。随附的第三方素材保留各自许可：Catppuccin 图标（MIT，`public/icons/catppuccin/`）、Noto Sans Mono（SIL OFL 1.1）、Symbols Nerd Font（MIT）、来自 `@lobehub/icons` 的 Provider 图标（MIT）。应用图标基于 pi 的 logo，归 pi 项目所有。
