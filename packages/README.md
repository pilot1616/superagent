# Codex Superagent local runtime

Independent Node.js runtime for the Codex migration; no DSH dependencies.

**Development preview, not a fully accepted coding agent. Real Workers remain disabled until the P0 security/recovery tests pass.** The service, task management, MCP bridge, read-only panel and fixture-tested PR adapter are implemented. No automatic login, plugin install, daemon launch, push, merge or data migration occurs.

Requires Node.js >=24.2.0, Git, and macOS/POSIX for this initial version. Codex adapter pins `codex-cli 0.154.0-alpha.6.2`; that is a compatibility pin, not a latest-version claim. The native SQLite API is experimental in the tested Node release.

From the source repository:

```sh
npm --prefix packages ci --ignore-scripts
npm --prefix packages run check
npm --prefix packages run probe
node packages/dist/service/src/cli.js help
```

After explicit installation of a built local package, the same CLI is available as `superagent-local`. Run `superagent-local help` for configuration and operations. Runtime state belongs outside both the repository and worktree roots. A Worker account/model must be configured separately in a future acceptance session; never copy the main Codex account's secrets automatically.

Detailed source documentation: `docs/codex-implementation-status.md` and `docs/codex-usage.md` in the project repository. Local operation does not imply offline inference: approved real model work would transmit necessary task/code context to the model provider.
