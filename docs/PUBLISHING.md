# 维护者：发布到 GitHub

本项目是独立 Git 仓库，默认分支 `main`，官方源码位置为 [endlessmaybe/devspace-shell](https://github.com/endlessmaybe/devspace-shell)。使用者下载 [Release 安装包](https://github.com/endlessmaybe/devspace-shell/releases/latest) 后，按 [新手指南](QUICKSTART.md) 和 [环境配置](ENVIRONMENT.md) 设置自己的环境。以下步骤供维护者发布后续更新。

## 本地发布检查

```bash
npm run check
npm run privacy
git diff --check
git status --short --ignored
npm run release
```

`release/` 下生成 ZIP、`SHA256SUMS.txt` 与 `manifest.json`。ZIP 只包含源码白名单文件；不会收录 `.runtime`、`.git`、数据库或用户数据。不要直接压缩整个工作目录，也不要复制本机数据目录来“初始化”别人的安装。

下载者的最短路径：Release → 下载完整 ZIP → 解压 → 双击「一键安装.cmd」→ 中文向导。GitHub 页面首页使用 README。第一版版本为 `v0.1.0`；发布说明应列明 Node、DevSpace codex 模式、GPT 授权与可选私有桌面桥接的兼容性限制。

## GitHub 上发布

既有仓库为公开仓库，上传后续修改前确认没有引入私人配置。原运行数据必须始终保持私有。不要重建仓库、强制推送或覆盖已有版本。

检查 `origin` 指向上述仓库；提交经过检查的源码并推送后，先查看 [CI](https://github.com/endlessmaybe/devspace-shell/actions/workflows/ci.yml)，确认对应提交的 Windows、Linux、macOS 检查成功。随后为该提交创建版本 tag 和 GitHub Release，上传 `release/devspace-shell-v版本号.zip`、`release/SHA256SUMS.txt`、`release/manifest.json`。下载发布资产后重新核对 SHA-256。发布说明使用 UTF-8 文件，通过 GitHub 网页或 `gh release create --notes-file` 提交，避免命令行转义破坏中文。

附带的 `release-candidate.yml` 仅通过手动运行工作流生成下载构件，**不会自动发布或推送 tag**。CI 在 Windows、Linux、macOS 上执行语法、隐私和回归检查；Windows 的安装器专有测试会在非 Windows runner 跳过。

以后更新版本：同时更新 `package.json` / `package-lock.json` / `CHANGELOG.md`，执行所有检查，生成新包并写清升级说明。升级只覆盖源码，保留用户数据；如修改数据库结构，必须新增迁移与升级回归测试。

## 不该上传

GPT 账号、访问令牌、Cookie、Owner 密码、OAuth 数据、聊天 ID、任务口令、执行结果、日志、个人记忆、SSH 密钥、内网地址、安装在 `.runtime` 中的二进制，均不是本项目源码。
