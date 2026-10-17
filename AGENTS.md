# DevSpace Shell contributor instructions

This is an independent, portable application. Never read or import another installation's memory, conversations, accounts, database, credentials, SSH configuration, or live runtime configuration.

- Keep code in `src/`, browser assets in `public/`, setup/release tools in `scripts/`, and tests in `tests/`.
- Runtime data belongs in the user's application-data directory or an explicitly supplied `DEVSPACE_SHELL_DATA` directory. It must never enter Git or release archives.
- Identify DevSpace-compatible plugins from their tool names AND JSON schemas, grouped by connector. Display names are labels, not identities. Catalog inspection does not prove a GPT connection; a fresh challenge callback does not prove a particular model identity.
- Preserve task leases and checkpoints across restarts. Never retry an uncertain message delivery automatically. A heartbeat alone is not business progress. Do not silently change executor, account, model, or shell.
- Bind the dashboard to loopback only. Validate Host/Origin and require authentication on private APIs. Pairing tickets must expire and be single-use.
- Never kill an unrelated process to reclaim a port. Startup and uninstall may manage only this installation's own resources.
- Use UTF-8 throughout. PowerShell scripts containing non-ASCII text need a BOM for Windows PowerShell 5.1.
- Before committing or packaging: `npm run check`, `npm run privacy`, `git diff --check`. Release packaging uses a source allowlist, never a recursive copy of the working directory.
- Do not create a remote, upload, publish, or push without a direct user request. Do not touch a running source installation while developing this shell.
