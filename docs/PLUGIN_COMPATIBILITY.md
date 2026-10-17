# DevSpace 插件名字不一样怎么办

**不用统一插件名字。** 名字只作为标签，识别依赖同一连接器的工具契约。

| 能力 | 工具名后缀 | 必需参数 |
| --- | --- | --- |
| 项目工作区 | `open_workspace` | `path: string` |
| 启动命令 | `exec_command` | `workspaceId: string`, `cmd: string` |
| 持续命令会话 | `write_stdin` | `workspaceId: string`, `sessionId: number/integer` |
| 文件补丁 | `apply_patch` | `workspaceId: string`, `patch: string` |

支持未加前缀的 MCP 服务目录，也支持 `mcp__任意插件名__exec_command`、`mcp.任意名字.exec_command`、`mcp__codex_apps__自定义名_exec_command` 等客户端名称空间。参数来自工具的 `inputSchema`，必需字段的类型与 required 声明必须匹配。完整工具名、参数和指纹在本地配置保存，后续任务使用已选择的映射，不在每一轮全局枚举所有插件。

同名但参数不符时拒绝匹配。工具来自不同 `serverId` 或名称空间时拒绝拼接。多个完整匹配时要求用户明确指定一个；不要让 GPT 随便选。仅靠描述里写“DevSpace”不够。

## 首次配对

1. 在 GPT 中安装并启用自己的 DevSpace 插件，完成其授权。
2. 确认 DevSpace 使用 `codex` 工具模式。1.0.8 通过运行服务的环境变量 `DEVSPACE_TOOL_MODE=codex` 配置；1.1 系列在自己的 `config.jsonc` 设置 `tools.mode`。具体步骤见 [环境配置](ENVIRONMENT.md)。修改后重启**你自己的 DevSpace 服务**并刷新客户端的工具目录。不要把变量设为系统全局值，也不要覆盖其他安装的配置。
3. 在 Shell 填写项目路径和命令环境，保存。生成配对口令，发给 GPT。
4. GPT 核对当前实际工具描述，用正确连接器打开你的项目，执行口令中的 `client.mjs pair`。实际的工具目录 JSON 要替换口令中的占位内容，不能原样粘贴占位符执行。
5. 控制台收到单次回连后显示「已配对」。口令过期就重新生成。配对失败不会触发对其他内核的自动切换。

同一设备上的命令回连是受信任本机客户端的可用性证明，不是插件作者认证。工具描述仍由客户端报告；不要给不可信客户端执行本机命令的权限。模型身份另外由 GPT 平台显示或提供收据，本壳子不会把配置值冒充模型身份。

## OAuth 插件的本机检测

高级设置可以向**明确输入的本机** `/mcp` 发送 `initialize`、`notifications/initialized` 和带分页的 `tools/list`。支持 JSON 与 SSE，遵守会话 ID，限制大小、页数及超时；不发送 `tools/call`，不修改项目。

若返回 401，表示 DevSpace 需要 OAuth。优先在 GPT 中完成授权再用配对口令，不要填 Owner 密码。可选 Bearer 字段仅为已经持有适用访问令牌的高级用户提供；值只用于这一次请求，不保存、不返回。此检测不等于 GPT 已连接。

## WSL2

命令环境选「WSL2」后，项目操作仍由现有 DevSpace 插件在其 Bash 环境执行。Shell 回执通过 WSL 的 Windows 程序互操作调用安装器选定的 Windows Node，从 Windows 侧访问回环端口，避免 NAT 模式下 Linux `127.0.0.1` 指向错误主机。

这只用于 Shell 的配对/租约/检查点回执，不会把项目命令换到 PowerShell。需要 WSL 开启正常的 Windows interop；纯 Linux 上部署 Shell 时直接使用本机 Node。不要为此关闭防火墙或 SSH host-key 检查。

## 官方参考

- [DevSpace 项目与设置](https://github.com/Waishnav/devspace)
- [DevSpace 配置参考](https://github.com/Waishnav/devspace/blob/main/docs/configuration.md)
- [MCP 工具发现协议](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [OpenAI：构建 MCP 插件服务](https://developers.openai.com/plugins/build/mcp-server)
- [OpenAI：连接并测试插件](https://developers.openai.com/plugins/deploy/connect-chatgpt)

客户端可用性、菜单、账号限制和隧道要求以各自当前官方说明为准。云端 GPT 不能直接访问另一个人的回环地址；应使用该使用者自己授权的 DevSpace 连接，不应公开 Shell 控制台端口。
