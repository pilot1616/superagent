# Codex Superagent local runtime

Independent Node.js runtime for the Codex migration; no DSH dependencies.

Workers support bounded native subagents within a task: new profiles allow up to 3 concurrent children at depth 1, share one task worktree, persist child progress/results, and clean up all children with the parent. Old profiles stay disabled until an explicit stopped-state `runtime configure-profile` change. Native model/tool availability still applies, and model usage increases without a hard token cap. See [the design](../docs/017-worker-subagents.md) and [configuration instructions](../docs/codex-usage.md).

The user-wide plugin now selects the **current conversation project**, not one installation-time repository. `superagent_project_open` binds each MCP connection to an explicit Git root and checks host MCP roots when provided. Different projects use independent service states and dashboards; sessions for the same project reuse its service. First setup needs explicit consent and a chosen/configured model. `mcp bridge --state PATH` remains an opt-in legacy fixed-instance mode; default bridge mode has no default repository.

The main workflow coordinates related tasks: durable shared threads and event routing, bounded dependency plans, priority/aging scheduling, exclusive resources, human continuation slots, fingerprint-bound plan authorization, accepted result handoffs, and integration acceptance. CLI prefixes include `thread`, `event`, `route`, `task` and `plan`; trusted result/plan acceptance stays outside public MCP. Database schema 2 backs up schema 1 before migration; this is distinct from service configuration version 3.

Delivery uses GitLab Merge Requests, with GitLab.com or an explicitly registered self-managed HTTPS origin (`init --gitlab-url`). Nested subgroup paths are supported. Service configuration is version 3 and GitLab writes default to disabled; migrate v2 explicitly while stopped using `runtime migrate`, and use a separate state directory instead of reusing legacy GitHub tasks, credentials or authorizations. Supply `gitlab.token` explicitly in the private state directory; existing glab/keyring credentials are not imported.

Runtime administration uses trusted `runtime status/check/verify-preview/verify/verification/enable-preview/enable/disable-preview/disable/reconcile` commands or authenticated dashboard routes, never public MCP. `runtime configure-profile` changes the model/provider only while stopped. Environment enablement requires a valid inspection and human confirmation, not a completed verification suite, and does not authorize tasks. Missing or incomplete verification is an explicit nonblocking warning. The optional verifier still performs protocol preflight only and records `inconclusive / VERIFICATION_BUDGET_UNSUPPORTED` before any model turn. Production execution has no enforced total token or cost cap; this is disclosed before enablement. No acceptance evidence is fabricated. The private state, credentials and real evidence must never be packaged.

**Development preview, not a fully accepted coding agent. Worker dispatch is allowed after environment checks, human project enablement and task/plan authorization; full isolation, lifecycle, model and multi-task acceptance remains incomplete but is no longer a dispatch gate.** The service, task management, MCP bridge, authenticated local approval/control panel and fixture-tested MR adapter are implemented. The panel requires same-origin CSRF-protected, explicit human confirmation for writes; public MCP cannot approve. User-wide plugin installation and macOS LaunchAgent hosting require explicit installation. No automatic login, push, merge or legacy-state import occurs.

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
