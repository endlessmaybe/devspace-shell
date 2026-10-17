# DevSpace Shell

[下载安装包](https://github.com/endlessmaybe/devspace-shell/releases/latest) · [新手指南](docs/QUICKSTART.md) · [环境配置](docs/ENVIRONMENT.md) · [版本兼容](docs/VERSION_COMPATIBILITY.md) · [问题反馈](https://github.com/endlessmaybe/devspace-shell/issues) · [CI 验证](https://github.com/endlessmaybe/devspace-shell/actions/workflows/ci.yml)

一个可以独立安装、自己配置的 DevSpace 工作台。把任务交给你自己的 GPT，通过你已经安装的 DevSpace 插件操作项目；任务、检查点和执行状态保存在本机。

**这是干净的通用壳子。** 首次启动没有历史任务、个人记忆、账号、聊天 ID、SSH 配置或其他用户的路径。你自己的项目代码和 GPT 账号仍由你管理。

## 三步开始（Windows）

1. 从 [Release](https://github.com/endlessmaybe/devspace-shell/releases/latest) 下载 `devspace-shell-v0.1.2.zip`，解压到你准备长期保存的位置。也可以直接下载源码 ZIP；不要只下载一个 `.cmd` 文件。
2. 双击 **`一键安装.cmd`**。安装器会检查 Node，缺少时下载并校验官方 Node 24.22.0；启动本机工作台并打开浏览器，默认添加**当前用户登录自启动**。不需要管理员权限、Git、npm 安装依赖或 API Key。
3. 跟随中文向导：填写自己的项目目录 → 选择使用方式并配对 DevSpace 插件 → 开始创建任务。桌面自动模式按名称连接专用隐藏会话，**无需填写任何聊天 ID**，以后重启复用；[首次连接说明](docs/HIDDEN_EXECUTOR.md)。

以后双击 `启动Dev.cmd`。`停止Dev.cmd` 停止本安装；`卸载Dev.cmd` 停止服务并移除本安装的登录自启动，保留任务数据。项目位置改变后，请重新运行安装器更新启动项。

不想开机启动：在 PowerShell 中运行 `./Install.cmd -NoAutoStart`，或在工作台「连接与设置」里关闭登录自启动。`-NoAutoStart` 只跳过本次安装启动项；已有启动项请在工作台关闭。

## 你需要准备什么

- Windows 10/11；推荐 Windows 11。应用本身只需要 Node.js **24–26**，安装器可自动补齐。
- 一个能正常使用的 GPT 客户端，以及**你自己安装、启用和授权的 DevSpace 插件**。插件安装、GPT 登录、OAuth 授权需要你在客户端完成，本安装器不会代为登录。
- DevSpace 启用 **`codex` 工具模式**，提供 `open_workspace`、`exec_command`、`write_stdin`、`apply_patch`。已有插件显示名字可以任意。如果只有 `bash` / `edit` 等工具，请按 [插件配置说明](docs/PLUGIN_COMPATIBILITY.md) 调整 DevSpace 工具模式并刷新客户端目录。
- DevSpace 的命令环境已经可用。Windows 使用 Git Bash 或配置好的 WSL2。此壳子不会迁移、覆盖或安装你的 WSL 发行版、SSH 密钥和客户端配置。

尚未配置 DevSpace 的用户先按 [环境配置](docs/ENVIRONMENT.md) 准备 Node/npm、Git、Bash、自己的 DevSpace 服务与 GPT 插件授权；一键安装只负责 Shell 自身。Shell 0.1.1 分别适配 DevSpace **1.0.8** 的 `workspaceId/sessionId` 与 **1.1.0-beta.4** 的 `workspace_id/session_id` 契约，并保存实际参数映射；不自动升级 DevSpace。其他版本按实际 Schema 检查，不承诺全部版本通用。配置差异与旧配对升级见 [版本兼容矩阵](docs/VERSION_COMPATIBILITY.md)。

GPT 的模型、订阅和权限由客户端决定。模型备注只用于展示，不会把网页 GPT 改成 API 模型；插件在线或任务领取也不代表模型版本已经核验。

## 选择你的使用方式

| 方式 | 适用客户端 | 如何开始 |
| --- | --- | --- |
| **通用模式（默认）** | 已连接本机 DevSpace 的 GPT | 配对后复制任务执行口令，发给 GPT。可使用全部任务、租约与检查点功能。 |
| **标准 MCP 任务连接器** | 支持 stdio MCP 的其他本地客户端 | 设置页生成配置，合并进客户端；同时保留自己的 DevSpace 工具连接。任务工具名为 `devshell_*`。 |
| **桌面隐藏会话 · 自动派发** | 提供兼容 app-tools 管道的 Windows Codex 桌面客户端 | 识别归档列表，按名称绑定专用 GPT 会话，勾选自动派发。首次缺少调用上下文时，连接口令由客户端本地终端自动回连，不手填 ID；[详细步骤](docs/HIDDEN_EXECUTOR.md)。 |

自动派发由本地后台控制器持续处理队列，异常退出后监督器重启；有效租约、任务及检查点保留。它不能让 GPT 在电脑关机、客户端退出或订阅额度耗尽时继续生成。

隐藏会话指专用**归档**聊天，不等于临时聊天或关闭记忆。Shell 不改用户的全局记忆设置，也不保证仅凭归档就能隔离 GPT 的记忆。当前桥接不自动创建普通 GPT / 临时聊天，不自动选择或接管用户日常聊天；初次选择后持久复用。

## 插件不同名称智能识别

配对不搜索某个固定显示名称。它把**同一连接器**的工具名称空间、完整工具名和 JSON Schema 参数合并核对，保存明确的工具映射与能力指纹。多个匹配时必须选择，缺少能力时说明缺少什么；不会把几个无关插件的工具拼在一起冒充 DevSpace。

本机 MCP 只读检测与 GPT 配对分开：前者检查目录，后者要求 GPT 经实际插件命令执行一次十分钟有效、单次使用的回连。回连证明命令链路可用；工具描述是客户端提供的能力声明，不是对插件作者或模型身份的加密认证。更换连接器或工具版本后请重新配对。

## 本机数据与发布

- Windows 数据目录：`%LOCALAPPDATA%\DevSpaceShell\data`。含配置凭据、任务 SQLite、状态、日志；**不要公开这个目录**。
- macOS/Linux：`${XDG_DATA_HOME:-~/.local/share}/devspace-shell`。可用 `DEVSPACE_SHELL_DATA` 显式选择独立目录。
- 源码目录内的 `.runtime/` 只存本机 Node 和启动辅助文件，已忽略。
- 发布包使用源码白名单生成，排除 `.git`、运行配置、数据库、记忆、聊天、日志、缓存、依赖与 `.runtime`。
- 本地工作台只监听回环地址；启动器将随机本机凭据交给浏览器。不要把认证链接或任务口令公开。

源码公开在 [endlessmaybe/devspace-shell](https://github.com/endlessmaybe/devspace-shell)。安装用户的运行数据保存在自己的电脑，不会加入发布包；公开提交仍需执行隐私检查。

## 开发与验证

零 npm 运行依赖。Node 24–26；开发和打包只需 Node，Git 仅用于版本管理。

```bash
npm run check       # JS 语法、源码隐私扫描、全部回归测试
npm run privacy     # 只报告文件、行号、规则，不回显匹配内容
npm run release     # 生成 release/ 下的安装 ZIP、清单、SHA-256
npm start           # 后台启动
npm stop
```

前台开发：`npm run dev`。首次浏览器认证请使用 `node scripts/manage.mjs start --open`。隔离测试请设置 `DEVSPACE_SHELL_DATA`，避免使用自己的正式数据。

macOS/Linux 可执行 `bash install.sh`，需要自行安装 Node 24–26；自动补 Node 和登录启动项目前只针对 Windows。跨平台核心在 CI 中检查，当前本地实机验收记录见 [验证说明](docs/VALIDATION.md)。

| 目录 | 用途 |
| --- | --- |
| `src/` | 持久队列、任务租约、插件能力识别、HTTP/MCP、可选桌面桥接 |
| `public/` | 中文向导与任务工作台，无外部字体、图片或 CDN |
| `scripts/` | 安装、启动、监督、自启动、命令回执、检查与打包 |
| `tests/` | 插件改名/冲突、OAuth 错误、单次配对、幂等、超时、重启、消息不确定性等 |
| `docs/` | 安装、架构、兼容性、隐私、故障排查、发布和验收 |
| `.github/workflows/` | Windows/Linux/macOS CI，以及手动生成发布候选包的工作流 |

贡献规则见 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。MIT 许可证；外部 DevSpace 与 Node 的要求见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

更多：[新手指南](docs/QUICKSTART.md) · [环境配置](docs/ENVIRONMENT.md) · [插件识别](docs/PLUGIN_COMPATIBILITY.md) · [排错](docs/TROUBLESHOOTING.md) · [维护者发布指南](docs/PUBLISHING.md)
