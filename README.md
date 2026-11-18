# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

### Codex Migration Preview

The independent Codex runtime now targets **GitLab Merge Requests**, including explicitly configured self-managed instances. The original DSH/GitHub prototype below remains unchanged. GitLab delivery is disabled by default. Worker dispatch requires environment checks, human project enablement and task authorization, but no longer requires the full acceptance suite; see `docs/codex-usage.md` for version-3 initialization and legacy-state restrictions.

新增独立 Codex 本地任务服务与插件入口，保留原 DSH 原型。**当前为开发预览：已移除完整验收硬门槛；环境检查、人工启用和任务审批后可派发 Worker。真实执行完整验收仍未完成，也没有强制总 token 预算。** 规则见 [016](docs/016-worker-verification-advisory.md)。全局插件和后台托管须显式安装，不自动复制账号、启动模型或向远端推送。网页审批边界见 [011](docs/011-local-control-panel.md)。

全局插件按当前会话项目绑定，不固定管理安装时的仓库。不同项目使用独立状态和控制台，同项目多会话复用服务；首次初始化需明确同意和模型配置。见 [012](docs/012-session-project-binding.md)。

Worker 内支持受控原生子 Agent 协作：新 profile 默认最多 3 个并发子 Agent、深度 1，共享任务 worktree，统一停止并展示分工与结论；旧 profile 不自动启用。见 [017 设计与边界](docs/017-worker-subagents.md)。

人工控制台提供精简任务分页、可点击依赖图、执行中追加/范围调整及跨轮阶段结论；门禁未验收时保留任务等待并显示具体诊断，不将任务判失败，也不绕过安全要求。见 [013](docs/013-task-cockpit.md)。

真实 Worker 的解锁契约见 [014 执行解锁设计](docs/014-worker-runtime-unlock.md)，逐项实施状态见 [015 实施记录](docs/015-worker-runtime-implementation.md)。动态门禁、独立诊断、人工启用接口与环境 UI 已实现；固定协议缺少可强制执行的验证总 token 预算，真实模型及多任务验收仍未通过，不能宣称已经解锁。

核心定位为**关联多任务协调与调度**：恢复共享上下文、订阅分发、主会话路由与槽位管理，扩展有界任务图、资源互斥、结果交接和整体验收。设计与可执行测试对应关系见 [010 多任务编排设计](docs/010-multi-task-orchestration.md)；本地假执行器流程通过不代表真实模型与 GitLab 发布已验收。

- [实施与验收状态](docs/codex-implementation-status.md)：逐项区分代码、fixture 测试和真实执行证据。
- [Codex 使用说明](docs/codex-usage.md)：构建、初始化、服务、MCP、审批、看板和恢复。
- 新运行时检查：`npm --prefix packages ci --ignore-scripts && npm run check:codex`。
- CLI 帮助：`node packages/dist/service/src/cli.js help`。

### Original DSH Prototype

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 Codex Plugin Design](docs/009-codex-plugin-design.md): migration design baseline for task management, execution, PR delivery, supervision and recovery (中文设计文档; implementation in progress)

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
