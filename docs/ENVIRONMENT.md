# 环境配置

## 安装前对照

| 项目 | 要求 | 安装器是否处理 |
| --- | --- | --- |
| Shell 工作台 | Windows 10/11，推荐 11；可写的固定目录、普通用户权限 | 一键启动；默认当前用户登录自启动 |
| Shell 运行时 | Node.js 24–26；Windows x64 / ARM64 | 缺少时下载并校验官方 Node 24.22.0，不改系统 PATH |
| GPT | 自己能正常使用的客户端和账号，支持自己的 DevSpace 连接 | 自行登录、授权；模型在 GPT 客户端选择 |
| DevSpace | 独立安装的服务，`codex` 工具模式 | 不随 Shell 捆绑，不覆盖已有服务 |
| DevSpace 命令环境 | Node/npm、Git、Bash；Windows 使用 Git Bash 或已配置的 WSL2 | 自行准备；仅有 cmd/PowerShell 不够 |
| 云端 GPT 接入 | 自己的 HTTPS 隧道和 DevSpace OAuth 授权 | 按 DevSpace 官方说明设置；不公开 Shell 控制台 |
| 项目环境 | 项目本身需要的 Python、编译器、数据库等 | 按自己的项目安装，不由本壳子提供 |
| 网络 | 首次补 Node 需访问 nodejs.org；装 DevSpace 需访问 npm；使用 GPT 需相应网络 | 不更改代理、SSH、账号池或防火墙 |

安装 Shell 不要求全局 Node/npm、Git、管理员权限或 API Key。上表中的 npm/Git/Bash 是**另行安装和运行 DevSpace**的要求。安装器下载的私有 Node 不会自动成为终端的全局命令。

## 已有 DevSpace

先用 `devspace doctor` 检查服务环境，再让 GPT 查看实际工具目录。必须由**同一连接器**提供 `open_workspace`、`exec_command`、`write_stdin`、`apply_patch` 及所需参数；插件显示名称可以任意。

Shell 0.1.1 适配 DevSpace **1.0.8** 的驼峰参数和 **1.1.0-beta.4** 的下划线参数；其他版本需要实际 Schema 匹配，见 [版本兼容矩阵](VERSION_COMPATIBILITY.md)。1.0.8 启动服务时需要在该进程环境中设置工具模式，例如 PowerShell：

```powershell
$env:DEVSPACE_TOOL_MODE = 'codex'
devspace serve
```

Git Bash / Linux / macOS：

```bash
DEVSPACE_TOOL_MODE=codex devspace serve
```

如果服务由启动脚本管理，把变量放进**自己的服务脚本**。不要启动第二个争用同一端口的实例。改动后重启自己的服务并刷新 GPT 工具目录。

**DevSpace 1.1 系列不同：** 上游已把此环境变量移到 `~/.devspace/config.jsonc` 的 `tools.mode`。在自己的现有文件中合并 `"tools": { "mode": "codex" }`，保留其他配置，再重启。不要把 1.0.8 的环境变量说明直接套用到 1.1，也不要为使用 Shell 强制升级现有 DevSpace。其他版本按实际工具 Schema 验证并重新配对。

## 还没安装 DevSpace

先安装全局可用的 Node 24–26、npm 和 Git；Windows 还需要 Git Bash 或可用的 WSL2。以下是新的独立安装示例，固定在兼容基线版本；已有服务可跳过，不要覆盖它：

```bash
npm install -g @waishnav/devspace@1.0.8
devspace init
devspace doctor
```

按初始化向导配置自己的项目允许目录与 HTTPS 地址；随后按上一节以 codex 模式运行服务。在 GPT 中添加自己的 DevSpace MCP 连接，并在官方授权页完成本人授权。默认本机 MCP 地址为 `http://127.0.0.1:7676/mcp`；云端 GPT 通常连接**自己的 HTTPS 隧道** `/mcp` 地址。Shell 工作台默认 `127.0.0.1:17861`，两者不能混填。

上游步骤见 [DevSpace 1.0.8 安装说明](https://github.com/Waishnav/devspace/blob/v1.0.8/README.md)、[1.0.8 配置](https://github.com/Waishnav/devspace/blob/v1.0.8/docs/configuration.md) 和 [1.1 配置迁移说明](https://github.com/Waishnav/devspace/blob/main/docs/configuration.md)。GPT 客户端是否允许自定义连接、其登录和授权入口，以该客户端当前功能为准。

## 连接 Shell

1. 下载 [安装包](https://github.com/endlessmaybe/devspace-shell/releases/latest)，完整解压，双击「一键安装.cmd」。
2. 在向导填写自己的项目路径；该路径应在 DevSpace 允许的目录内。选择 DevSpace 实际使用的 Git Bash 或 WSL2 环境。
3. 生成配对口令，发给已启用自己 DevSpace 插件的 GPT。GPT 要通过实际插件命令回连；不能原样执行含占位符的示例工具目录。
4. 创建一个小任务，例如读取项目说明并回报摘要，复制执行口令给 GPT。确认任务从待领取变为 RUNNING，再看到结果与验证证据。

通用模式需要把任务口令发送给 GPT。需要队列自动派发时，另行按设置页配置兼容 Windows 桌面客户端的调用聊天和独立归档执行聊天；默认不启用。没有兼容桌面桥接时，使用通用模式或标准 stdio MCP 任务连接器。

WSL2 用户应保证 Windows interop 可用，使用生成口令里的 Windows Node 回执命令；项目命令仍交给自己的 DevSpace Bash。Shell 不安装 WSL、不开 SSH 信任例外。

## 数据、升级与长期运行

Windows 数据默认在 `%LOCALAPPDATA%\DevSpaceShell\data`；macOS/Linux 在 `${XDG_DATA_HOME:-~/.local/share}/devspace-shell`。可用 `DEVSPACE_SHELL_DATA` 选择独立目录，安装器也支持 `Install.cmd -DataDir "你自己的绝对目录"`。保持这一选择一致，避免切到另一个空实例。

升级前停止 Shell，备份自己的数据，解压新版本到固定位置后重新运行安装器；它会更新本安装的登录启动项。卸载保留任务数据。不能把配置、数据库和日志一起打包发给其他用户。

长期运行需要设备开机、用户已登录、DevSpace 服务与必要隧道在线。桌面自动派发还需要客户端保持登录且额度可用；Shell 的监督器只恢复自己的控制进程，不能代替 GPT 授权、客户端或上游服务自启动。任务领取、心跳与完成是不同状态，不确定发送不会自动重放。

macOS/Linux 先自行装好 Node 24–26，再运行 `bash install.sh`；Windows 的自动下载运行时与登录启动项功能不适用于这两类系统。
