# DevSpace 版本兼容

Shell 和 DevSpace 是两个独立程序，有各自的版本号。Shell 0.1.1 加入两套明确的工具参数适配；安装或升级 Shell **不会升级、降级或改写现有 DevSpace 服务**。

## 当前兼容矩阵

| DevSpace | 工具模式配置 | 工作区参数 / 返回字段 | 进程会话字段 | Shell 行为 |
| --- | --- | --- | --- | --- |
| 1.0.8 稳定版 | 服务进程的 `DEVSPACE_TOOL_MODE=codex` | `workspaceId` | `sessionId` | 适配 `codex-camel` 契约 |
| 1.1.0-beta.4 预览版 | 自己的 `config.jsonc` 中 `tools.mode="codex"` | `workspace_id` | `session_id` | 适配 `codex-snake` 契约；不会自动升级到预览版 |
| 其他版本、重命名或定制连接器 | 按该服务的实际配置 | 以实际 Schema 为准 | 以实际 Schema 为准 | 只有完整匹配上述某一套契约才配对，标记为按契约匹配，不承诺整版兼容 |
| minimal / full / claude 等不含四项所需能力的目录 | 需改为该版本的 codex 模式 | 不匹配 | 不匹配 | 拒绝配对，显示配置与参数检查提示 |
| 改名参数、跨版本混用、额外未知必填项或矛盾的输出 Schema | 需要新增明确适配 | 不匹配 | 不匹配 | 拒绝配对，不派发任务，不自动换内核 |

`open_workspace.path`、`exec_command.cmd` 和 `apply_patch.patch` 在两套契约中相同。`write_stdin` 的会话号为 number / integer。四项工具必须来自同一连接器；不能把旧版的命令工具和新版的会话工具拼起来。

## 为什么不能只看版本号

正式发布的 **DevSpace 1.0.8** 在 MCP `serverInfo.version` 中声明的是 **`0.1.0`**；这与 npm 包版本不同。Shell 不会把它误判为不支持，也不会假装这个声明证明了安装包版本。

只读检测和配对报告会显示服务声明版本、参数契约、配置方式与核验范围。未提供版本、版本号与契约不一致或未知版本时，仍严格核对工具 Schema，标记为 `schema-only`。`baseline` / `preview` 仅表示声明与已知契约一致；`versionVerified` 始终为 false。客户端声明与命令回连不能认证软件发行者或 GPT 模型。

## 实际适配内容

- 识别并保存每项工具的**实际参数名**；任务口令按已配对映射调用，并读取对应的工作区和进程返回字段。
- 工具指纹包含输入与已提供的输出 Schema。没有完整契约、出现未知必填项或字段类型矛盾时不配对。
- MCP 只读检测使用初始化协商得到的协议版本；即使新版服务不发会话 ID，后续请求也携带 `MCP-Protocol-Version`。不支持或缺少协议版本时停止检测，不发送工具调用。
- 0.1.0 Shell 的旧配对会在启动时从已保存的工具 Schema 补齐映射。无法补齐时要求重新配对，保留任务和检查点，阻止新的派发。
- 执行口令要求 GPT 在业务操作前核对当前实际工具。升级 DevSpace 或刷新工具目录后，应重新配对；Shell 无法在没有访问上游服务时实时探知插件偷偷升级。

## 升级 Shell

停止自己的 Shell，备份自己的数据，下载 [最新版完整 ZIP](https://github.com/endlessmaybe/devspace-shell/releases/latest)，替换源码后重新运行安装器。保留原数据目录与 `DEVSPACE_SHELL_DATA` 选择。无需修改任务数据库，也无需重装 DevSpace。

若原配对显示需要重新核对，先停止或核实旧 GPT 执行器，再生成新的配对口令。不要清空数据库或复制发布者配置来解决兼容问题。

## 验证依据

回归使用 npm 正式发布的 `@waishnav/devspace@1.0.8` 和 `@waishnav/devspace@1.1.0-beta.4` 中的工具注册输入 Schema，提取为 `tests/fixtures/` 快照；保留参数类型、required 和约束，移除描述。提取时使用 Zod 4.4.3 转换，没有执行上游工具处理器。测试覆盖两套改名连接器、参数口令、真实本机 HTTP 配对、重启保留、混用拒绝、旧配对升级及协议协商。

这是协议与本机控制器兼容验证，不等于所有账户的 GPT/OAuth 实机登录或新版 DevSpace 全功能验收。图形与实际登录边界见 [验证记录](VALIDATION.md)。

上游依据：[1.0.8 工具源码](https://github.com/Waishnav/devspace/blob/v1.0.8/src/server.ts)、[当前 codex 工具源码](https://github.com/Waishnav/devspace/blob/main/src/tool-surfaces/codex.ts)、[1.0.8 配置](https://github.com/Waishnav/devspace/blob/v1.0.8/docs/configuration.md)、[新版配置](https://github.com/Waishnav/devspace/blob/main/docs/configuration.md)。快照来源以各 JSON 中固定的 npm 发布包 URL 为准，不随上游 main 改动。
