# 维护者：发布到 GitHub

本项目是独立 Git 仓库，默认分支 `main`。提取过程不创建远程仓库、不添加 remote、不登录 GitHub、不推送。你可以自行发布这个源码仓库。

## 本地发布检查

```bash
npm run check
npm run privacy
git diff --check
git status --short --ignored
npm run release
```

`release/` 下生成 ZIP、`SHA256SUMS.txt` 与 `manifest.json`。ZIP 只包含源码白名单文件；不会收录 `.runtime`、`.git`、数据库或用户数据。不要直接压缩整个工作目录，也不要复制本机数据目录来“初始化”别人的安装。

下载者的最短路径：Release → 下载完整 ZIP → 解压 → 双击「一键安装.cmd」→ 中文向导。GitHub 页面首页使用 README。建议第一版标记 `v0.1.0`，说明可选私有桌面桥接的兼容性限制。

## GitHub 上发布

由你创建**空的**仓库并选择可见性。公开前确认后续修改没有引入私人配置。这个壳子按公开源码准备，原运行数据必须始终保持私有。

绑定你自己确认的仓库并推送 `main` 后，可以手动创建 Release 上传生成的 ZIP 和校验文件。附带的 `release-candidate.yml` 只通过手动运行工作流生成下载构件，**不会自动发布或推送 tag**。CI 在 Windows、Linux、macOS 上执行语法、隐私和回归检查。

以后更新版本：同时更新 `package.json` / `package-lock.json` / `CHANGELOG.md`，执行所有检查，生成新包并写清升级说明。升级只覆盖源码，保留用户数据；如修改数据库结构，必须新增迁移与升级回归测试。

## 不该上传

GPT 账号、访问令牌、Cookie、Owner 密码、OAuth 数据、聊天 ID、任务口令、执行结果、日志、个人记忆、SSH 密钥、内网地址、安装在 `.runtime` 中的二进制，均不是本项目源码。
