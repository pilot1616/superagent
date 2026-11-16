# Codex 改造实施与验收记录

更新：2026-11-16。设计依据：[009 Codex 插件改造设计](009-codex-plugin-design.md)。

## 结论：开发预览，不是完整 v1 验收通过

代码已按设计拆出独立的任务服务、领域层、SQLite 存储、Codex 适配器、MCP、插件、GitHub 交付适配器和只读看板。原 `src/`、DSH 接入、旧启动方式及旧数据库均保留；新运行时不导入 DSH。

**目前可以启动任务服务、通过 MCP 管理任务、使用本地看板；不能把它称为已经可以安全执行真实编码任务的 Agent。** P0 尚未完成，真实 Worker 在创建工作树/进程之前直接拒绝执行。这是设计要求的 fail-closed 门禁，不通过 `danger-full-access` 或复制当前账号凭据绕过。

GitHub 网络写入默认关闭，验证仅使用临时本地 Git 仓库和伪 GitHub 适配器；没有向生产仓库 push 或创建 PR。没有全局安装插件、改 Codex 主配置、登录 Worker、添加远程仓库、启动 launchd 或导入旧数据。

## 分阶段状态

| 阶段 | 实现与本地证据 | 尚未完成的验收 |
| --- | --- | --- |
| P0 协议与安全 | 固定本机 `codex-cli 0.154.0-alpha.6.2`；生成协议类型；真实 stdio 握手、独立 HOME/CODEX_HOME、账号状态读取、限制配置回读 | 文件系统 deny 的实际执行效果、真实审批往返、interrupt 后子进程归属与回收、断线后线程核对、带认证模型 turn；不能只看配置就认定隔离成立 |
| P1 核心/存储 | 人工来源、持久授权、版本冲突、幂等、事务内审计/effect、单写者、SQLite WAL、磁盘备份、停止锁、恢复为不确定态 | 旧数据库导入明确不做；高容量压测和完整业务兼容迁移未做 |
| P2 执行 | 独立 App Server、thread/start/resume、turn/start/interrupt、输入发送记录、报告校验、连接 epoch、超时拒绝、版本/profile 检查、进程记录；生产执行入口被门禁阻断 | `turn/steer`、observed 投递事实、自动 thread/read 核对、真实取消/孤儿回收、完整执行集成测试、实际 usage；不能宣称完整恢复 |
| P3 插件/MCP | 10 个公共工具、官方 SDK stdio、短 RPC、Bridge/Admin 分权、独立服务、Skill/manifest、显式本地配置脚本；真实 MCP Client→stdio Bridge→Unix socket→SQLite 测试 | 用户 Codex CLI/桌面端的实际安装与新会话验收；没有自行安装 personal marketplace |
| P4 PR 交付 | tree SHA 覆盖已跟踪及未跟踪文件；diff/head/作者/说明绑定审批；服务 commit-tree、非强推、按分支找 PR、所有权校验、持久 commit 核对点；评论/审查/CI 去重、只观察绑定 PR、读取退避 | 独立 GitHub 测试仓库的真实发布/超时/分支保护验收；无评论写回 outbox；未知且没有 PR 的 push 结果只报待核对，不盲目重发 |
| P5 监督/运维 | 可信 CLI、只读 React 看板、回环绑定、Host/Origin 校验、HttpOnly+SameSite 会话、CSP、事件分页、健康指标、暂停/备份/恢复入口 | 网页写审批未开放（使用 CLI）；自动启动/卸载/升级与备份恢复演练、跨平台和浏览器人工视觉验收未做 |
| P6 独立交付 | 独立 package/lock/build、运行代码无 DSH、包文件白名单、可构建本地 npm 包、路径显式生成插件副本 | 不宣称产品级发布完成；需 P0/P2/P4 通过后做真实安装、更新、回滚验收与原型归档决策 |

设计中“按阶段验收”与“可以先实现后续静态代码”必须区分：后续模块的 mock/fixture 测试不使 P0 自动通过。

## 实现对应关系

| 设计边界 | 唯一新运行时实现 |
| --- | --- |
| Domain/授权/状态机 | `packages/core/src/model.ts`、`engine.ts`、`ports.ts` |
| SQLite/事务/幂等/审计 | `packages/storage/src/store.ts` |
| 单实例/IPC/调度/可信 CLI | `packages/service/src/config.ts`、`daemon.ts`、`ipc.ts`、`cli.ts` |
| Git 工作空间 | `packages/service/src/workspace.ts` |
| Codex wire protocol/专属执行 | `packages/executor-codex/src/`、版本化 `protocol/` |
| GitHub API/发布/核对 | `packages/integrations-github/src/` |
| MCP 工具 | `packages/mcp/src/bridge.ts` |
| 插件入口 | `plugins/superagent/` |
| 本地只读面板 | `apps/panel/`、`packages/service/src/panel.ts` |

目录已模块化，当前使用一个独立 `packages/package.json` 编译/打包，而不是提前发布多个相互依赖的 npm 包。`core` 依赖持久化端口，不导入 SQLite 或 Codex wire types。原型保持历史基线，不把新的人工业务与旧主动评估实现混用。

## 已执行检查

- `npm --prefix packages run check`：后端和面板 TypeScript 检查、生产面板构建、19 项 Node 测试全部通过。
- `npm --prefix packages run probe`：本机真实 App Server，无模型调用；隔离账号未认证，`modelTurnTested=false`，配置回读不等于文件系统隔离验收。
- 临时 Git 工作树测试：原 checkout 不变，固定 base、分支归属、危险目录与符号链接拒绝。
- 真实本地 MCP transport：工具数量/允许列表、重复写幂等、人工授权、暂停不派发、停止持久化、备份与服务重启。
- GitHub fixture：未跟踪文件纳入预览、审批后修改拒绝、一次创建、远端 head/仓库校验、反馈去重、响应丢失核对、不解除停止。
- 安全检查：非交互批准拒绝、错误 token/admin 分权、profile 篡改拒绝、锁所有权、回环看板 Host/Origin/会话与只读 API。
- 独立进程 SIGKILL 后重新打开 SQLite：已提交 WAL 数据保留，sending 输入及 running effect 转为待核对，没有自动重投；这不是 Codex 真实 turn 恢复验收。
- npm 包在临时目录安装，仅生产依赖即可启动 CLI help；插件副本在临时目录生成并通过验证，未执行全局安装。
- 本地 plugin-creator、skill-creator 验证器校验 manifest 与 Skill。Python 校验依赖装在临时 venv，没有修改全局 Python。

检查不是生产安全认证。旧根项目 `pnpm check` 所需的 DSH/pnpm 环境未在本次安装，不能把新包检查称为全项目检查通过。

## 明确限制与下一步

1. **先做 P0，不直接打开门禁。** 用户需明确选择 Worker 的模型和独立认证方式；不能复制主会话的 auth 文件。使用专门临时仓库验证读取服务 token、其他任务文件、用户 home、共享 Git 元数据都被阻断。若无法实现，改用受限 OS 账号/容器。
2. 验证请求审批的具体 payload、返回值、超时/断连失效、终止真实子进程树，然后补 `turn/steer` 和持久线程核对。当前 Runtime 权限扩张只能拒绝，不能审批放行任意 shell。
3. `reconcile` 是人工审计入口，不是自动恢复证明：必须自行核对进程、线程、输入、工作树后明确选择 `settled` 或 `pending`；恢复后仍处于 humanHold，需要再次申请 resume。
4. Worker 输出中的 checks 是声明，不冒充独立测试结果。无 PR 的 ready 结果由人执行 `complete` 接受交付；PR 的 ready 不代表合并。
5. PR 反馈按“不可信外部输入”记录，默认要求范围复核后显式 resume。暂不自动对评论判断范围，也不把反馈当授权。
6. 发布 SHA 已知且唯一 PR 匹配时可核对落库；若 Git push 成功但 PR 未创建，或没有持久 commit 核对点，则保持待核对，不执行通用重试。
7. 同一 OS 用户的任意恶意进程仍可攻击用户自己的文件；0700/0600/Unix socket/CLI TTY 不是对同用户任意代码的安全沙箱。Worker 安全取决于尚待验证的隔离边界。
8. 看板只读、手工启动，无自动后台驻留。账号可用性和 usage 未验证时显示 null/未知，不填伪造的 0。

运行步骤见 [Codex 使用说明](codex-usage.md)。
