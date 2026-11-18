# Codex 改造实施与验收记录

## 2026-11-18：Worker 内受控多 Agent

依据 [017 设计](017-worker-subagents.md)，新增 profile 默认开启原生子 Agent（并发 3、可配置 1–4、深度 1），旧 profile 保持关闭。适配固定版本的 v1 collaboration 与 v2 subAgentActivity，持久记录分工、父子关系、状态和未验收结论，任务详情和环境预览展示子 Agent 与潜在模型会话规模。父任务停止、结束、超时及异常统一清理；重启或清理不确定不冒充已停止。保留任务图、独立 worktree、审批与验收语义，不自动修改其他项目的配置或登录状态。

本轮新增真实 Codex + loopback provider fixture，已执行原生 spawn 两个子 Agent、各自返回结论、主 Agent 等待汇总与统一进程清理；没有使用真实账号或外网付费模型。分工的文件写集仍靠主 Agent 协调，共享工作区不是文件锁；未知模型/不支持的原生工具不自动替换。完整生产隔离与真实账号验收仍未完成。

本轮最终 `npm --prefix packages run check`：**144/144 通过，0 失败，0 skip**；skill 校验与 `git diff --check` 通过。覆盖原生双子 Agent、元数据只读重查、父子身份与工作区校验、结果隔离、停止/恢复，以及进程组 EPERM 的独立证据判定。源代码与仓库中的插件 skill 已更新，未重新安装全局插件或自动热升级旧后台实例/profile。

## 2026-11-18：移除 Worker 完整验收硬门槛

本节优先于下方历史记录。按用户要求，完整验收由派发条件改为风险提示；没有验证记录、验证未通过或已过期，不再阻止环境就绪、人工启用和任务派发。不伪造证据或能力；仍保留环境检查、独立认证、人工启停、任务/计划审批、停止锁和恢复隔离。详见 [016](016-worker-verification-advisory.md)。真实模型与多任务验收仍未完成。

本轮 `npm --prefix packages run check`：**132/132 通过，0 失败，0 skip**。真实 Codex App Server 配合临时 Git 仓库及本机假 provider，已确认无验收记录也能完成实际派发、建立 thread 并发送模型协议请求；假 provider 拒绝推理，不调用付费模型、不使用真实账号。另修复重复传递 thread cwd 导致配置自动写入 trust、继而误触发指纹失效的问题，工作目录匹配和配置保护仍保留。

更新：2026-11-17。设计依据：[009 Codex 插件改造设计](009-codex-plugin-design.md)及 [010 关联多任务编排与调度设计](010-multi-task-orchestration.md)。

## 014 执行解锁改造：当前状态

本节是 016 修订前的历史记录；详情见 [015 实施记录](015-worker-runtime-implementation.md)。尚未满足原 014 的完整验收定义；这不再作为派发前置条件。

- 已实现动态 RuntimeController、严格实体 schema、版本/构建/profile/协议/认证代次指纹、真实证据引用和完整性校验、CAS/幂等/一次性预览、项目人工启用、fence 和 assignment permit。生产不再由永久布尔常量决定，但没有证据仍不执行。
- 保留多任务 DAG、人工验收、资源锁、计划预算、humanHold 和原子 claim。预启动撤回不消耗模型尝试；发送结果未知不回退重投。
- 已补独立 provider/profile、共用 WorkerRuntime、固定协议生成清单、扩权拒绝/澄清回答/投递阶段、进程身份观察和隔离；它们的代码存在不代表已通过真实 Worker 验收。
- 面板增加环境区、独立 Cookie、原子私有令牌/实例发布、第二实例拒绝、登录轮换/错误分类及人工管理路由；公开 MCP 没有新增启用、验证、登录或批准能力。
- service.json 为 version 3，SQLite 仍为 schema 2，WorkerProfile 为 version 2；旧 GitLab v2 必须停服、核对后显式迁移并备份，不能手改版本号。
- 当前验证器只完成零模型调用的协议预检；固定 `turn/start` 没有强制总 token 预算契约，结果必须为 `inconclusive / VERIFICATION_BUDGET_UNSUPPORTED`。V2–V7、R01–R10 仍未完成，需要受限/预算后端、独立账号和真实人工验收。
- 本轮 `npm --prefix packages run check`：**128/128 通过，0 skip**，包含后端/面板 TypeScript、生产面板构建以及 22 项新增回归（实施前 106 项）。固定 App Server 的本地假 provider 测试确认模型请求为零，不计作真实模型验收。
- npm 包在临时目录实际打包、仅生产依赖安装；CLI help、安装后协议指纹/只读检查通过。临时安装的 service/panel 冒烟检查确认仍不派发 Worker；打包清单包含 protocol manifest、验证器和环境控制器，不含测试、token、SQLite 或 auth。没有发布到 registry 或全局安装。
- `git diff --check`、Markdown 本地链接/代码围栏及 Skill 验证通过；Skill 校验的 PyYAML 仅使用临时 `uv run --no-project --with pyyaml` 提供，不修改全局环境。
- 未更改任何真实项目 state、登录凭据或服务，未重新安装/发布插件，未提交 Git。下方旧版本数字与本机运行描述均为历史，不代表本次重新执行。

## 2026-11-17 人工任务驾驶舱

- 按 [013](013-task-cockpit.md) 增加计划优先入口、10 条分页与筛选搜索、可点击分层依赖图、独立审批页；完整范围、预算与发布 diff 仍须人工预览，UUID/原始 JSON/审计默认折叠。
- 增加版本化 task_adjust 和网页“暂停并调整范围”：撤销旧授权、停止与重新审批、计划成员整组失效、保护独立停止及已验收结果、保留既有尝试预算。追加说明明确在下一轮消费，不冒充即时 steer。执行后不能直接改写依赖拓扑。
- checkpoint 独立持久化，保留阶段进展、最终报告和失败记录的原范围及轮次；去重、旧执行拒绝、分页和数据库重启留存有测试。进展不是验收结果，不会解锁下游。
- 修复门禁关闭时消耗 launch effect 并导致任务失败的问题；核心 claim 和 daemon 均保留任务等待，显示 waiting_runtime。诊断按钮受会话与 CSRF 保护，公开 MCP 无 Worker 诊断或审批权限。
- 完整构建与测试 **103/103 通过**。隔离临时仓库中的真实 Chrome 页面交互验证通过：4 节点 DAG、节点详情、阶段结论、追加说明、整组调整撤权、10 条分页、搜索和移动端内部图滚动；浏览器异常为 0。此处使用测试执行器，不是真实模型验收。
- 本机当前源码项目 Worker 检查：Codex 版本匹配、握手及受限配置读回通过，但 accountConfigured=false；5 项真实执行验收仍未完成，门禁保持关闭。不能声称“登录即可直接启动”或把配置读回当成 OS 隔离证明。
- 当前会话源码项目没有运行、排队或不确定任务，已安全重启其服务并加载新面板，诊断结果已保存；没有修改 insight-plugins1 服务、创建生产任务、批准真实任务、执行模型 turn 或写入 GitLab。新 task_adjust 工具需新 MCP 连接发现；未声称旧会话已热更新。

## 结论：开发预览，不是完整 v1 验收通过

代码已按设计拆出独立的任务服务、领域层、SQLite 存储、Codex 适配器、MCP、插件、GitLab 交付适配器和本地审批控制台。原 `src/`、DSH 接入、旧启动方式及旧数据库均保留；新运行时不导入 DSH。用户授权的网页写控制与全局安装按 [011](011-local-control-panel.md) 实施；下方早期验收记录中的“只读/未安装”描述保留为历史记录，不代表当前状态。

**目前可以启动任务服务、通过 MCP 管理任务、使用本地看板；不能把它称为已经可以安全执行真实编码任务的 Agent。** P0 尚未完成，真实 Worker 在创建工作树/进程之前直接拒绝执行。这是设计要求的 fail-closed 门禁，不通过 `danger-full-access` 或复制当前账号凭据绕过。

GitLab 网络写入默认关闭，验证仅使用临时本地 Git 仓库和伪 GitLab 适配器；没有向生产仓库 push 或创建 MR。没有全局安装插件、改 Codex 主配置、登录 Worker、添加远程仓库、启动 launchd 或导入旧数据。

**产品核心已按 010 补回关联多任务协调与依赖调度实现。** 原有 Thread/订阅/关联证据、事件 fan-out、主会话路由与退回、差异化槽位已恢复为宿主无关实现；增加任务计划 DAG、依赖验收、资源互斥、优先级老化/同级公平、计划授权、代码基线交接和整组操作。完整本地服务流程使用假执行器验收；不代表真实 Worker 或真实 GitLab 发布已经通过。

## 分阶段状态

| 阶段 | 实现与本地证据 | 尚未完成的验收 |
| --- | --- | --- |
| P0 协议与安全 | 固定本机 `codex-cli 0.154.0-alpha.6.2`；生成协议类型；真实 stdio 握手、独立 HOME/CODEX_HOME、账号状态读取、限制配置回读 | 文件系统 deny 的实际执行效果、真实审批往返、interrupt 后子进程归属与回收、断线后线程核对、带认证模型 turn；不能只看配置就认定隔离成立 |
| P1 核心/存储 | 人工来源、持久授权、版本冲突、幂等、事务内审计/effect、单写者、SQLite WAL、磁盘备份、停止锁、恢复为不确定态 | 旧数据库导入明确不做；高容量压测和完整业务兼容迁移未做 |
| 关联多任务编排（核心恢复及扩展） | M1–M5 的本地实现与用例：共享线程/路由、图持久化、候选与 claim 双校验、并行汇合、指纹授权、资源与恢复、结果验收、真实临时 Git 基线、CLI/MCP/只读图 | 真实模型并行、turn 内 steer、GitLab 测试项目发布和实际 Codex 插件会话仍需外部验收；第一版不支持已执行图热改、任意父子树、跨仓库或自动合并 |
| P2 执行 | 独立 App Server、thread/start/resume、turn/start/interrupt、输入发送记录、报告校验、连接 epoch、超时拒绝、版本/profile 检查、进程记录；生产执行入口被门禁阻断 | `turn/steer`、observed 投递事实、自动 thread/read 核对、真实取消/孤儿回收、完整执行集成测试、实际 usage；不能宣称完整恢复 |
| P3 插件/MCP | 26 个公共工具（含线程、路由与计划）、官方 SDK stdio、短 RPC、Bridge/Admin 分权、独立服务、Skill/manifest、显式本地配置脚本；真实 MCP Client→stdio Bridge→Unix socket→SQLite 测试 | 用户 Codex CLI/桌面端的实际安装与新会话验收；没有自行安装 personal marketplace |
| P4 MR 交付 | tree SHA 覆盖已跟踪及未跟踪文件；diff/head/作者/说明绑定审批；服务 commit-tree、非强推、按分支找 MR、所有权校验、持久 commit 核对点；评论/审查/CI 去重、只观察绑定 MR、读取退避 | 独立 GitLab 测试仓库的真实发布/超时/分支保护验收；无评论写回 outbox；未知且没有 MR 的 push 结果只报待核对，不盲目重发 |
| P5 监督/运维 | 可信 CLI、回环审批控制台、Host/Origin/CSRF、HttpOnly+SameSite 会话、CSP、单次指纹预览、逐项确认、版本化任务/计划控制、结果验收；本机用户级插件与 LaunchAgent 已安装 | 未验证跨平台、真实 Worker 隔离与完整备份恢复演练；跨会话工具仅做 MCP 协议验证，未发起真实模型会话 |
| P6 独立交付 | 独立 package/lock/build、运行代码无 DSH、包文件白名单、可构建本地 npm 包、路径显式生成插件副本 | 不宣称产品级发布完成；需 P0/P2/P4 通过后做真实安装、更新、回滚验收与原型归档决策 |

设计中“按阶段验收”与“可以先实现后续静态代码”必须区分：后续模块的 mock/fixture 测试不使 P0 自动通过。

## 实现对应关系

关联多任务增补：`packages/core/src/coordination.ts`、`scheduler.ts`；SQLite schema 2 自动备份升级（服务配置仍为版本 2）；用例见 `coordination.test.ts`、`coordination-service.test.ts` 和扩展后的恢复/安全测试。原 `src/` 与原 DSH 测试不改动，不声称直接复用了不能脱离 DSH 运行的旧测试；旧行为作为新用例的对照。

| 设计边界 | 唯一新运行时实现 |
| --- | --- |
| Domain/授权/状态机 | `packages/core/src/model.ts`、`engine.ts`、`ports.ts` |
| SQLite/事务/幂等/审计 | `packages/storage/src/store.ts` |
| 单实例/IPC/调度/可信 CLI | `packages/service/src/config.ts`、`daemon.ts`、`ipc.ts`、`cli.ts` |
| Git 工作空间 | `packages/service/src/workspace.ts` |
| Codex wire protocol/专属执行 | `packages/executor-codex/src/`、版本化 `protocol/` |
| GitLab API/发布/核对 | `packages/integrations-gitlab/src/` |
| MCP 工具 | `packages/mcp/src/bridge.ts` |
| 插件入口 | `plugins/superagent/` |
| 本地审批控制台 | `apps/panel/`、`packages/service/src/panel.ts`、`panel-actions.ts`、`panel-token.ts` |

目录已模块化，当前使用一个独立 `packages/package.json` 编译/打包，而不是提前发布多个相互依赖的 npm 包。`core` 依赖持久化端口，不导入 SQLite 或 Codex wire types。原型保持历史基线，不把新的人工业务与旧主动评估实现混用。

## 2026-11-17 GitLab 平台迁移

- 新运行时由 `integrations-github` 切换为 `integrations-gitlab`；任务字段改为 `mergeRequest`/`iid`，事件来源与健康信息改为 GitLab。原 DSH `src/` GitHub 实现保持历史基线。
- 使用 GitLab REST v4：项目路径整体 URL 编码，验证项目 ID/path/URL，按 source branch 查找 MR，再创建或读取项目内 IID；校验 host/project/source/target/head，拒绝跨项目 fork。
- 支持 GitLab.com、显式 `--gitlab-url` 自建 HTTPS 实例、多级 subgroup、HTTPS/SSH origin；受控 push 始终使用登记实例的 HTTPS 目标，认证头不进入 argv，禁止重定向和强推。
- 反馈读取 notes/discussions、系统消息、MR pipelines 和当前 head 的项目 pipelines；分页与持久去重保留，状态变化重新入队。系统审批消息不是服务授权；不调用 approve/merge API，也不承诺完整审批规则状态读取。
- 服务配置升级为 version 2、`gitlabEnabled`；凭据改为私有 `gitlab.token`。拒绝旧 GitHub 配置/仓库/任务，要求独立 state 和重新审批，不自动搬运已有 `glab`/keyring 凭据或修改用户 remote。
- 构建清理 dist 防止旧适配器残留；回归覆盖 REST 请求形状、MR IID、分页、token/host 边界、Git push 参数、旧状态拒绝，以及原有审批/取消/恢复逻辑。没有请求真实 GitLab 项目或创建 MR；真实 Worker 和网络写入默认仍关闭。
- 迁移后 `npm --prefix packages run check`：**46/46 测试通过**（此前 33 项保留并适配，新增 13 项）；包含自建实例多级 subgroup 的临时工作树→预览→批准→模拟 MR 发布→SHA 对账闭环。`git diff --check`、插件 Skill 校验通过；运行包 dry-run 仅包含 GitLab 适配器，不包含旧 GitHub 模块、测试、token 或数据库。

## 2026-11-17 Review 修复

- 发布批准携带用户看到的 `expectedFingerprint`，授权事务同时核对展示值、持久预览和重算值；刷新同一审批 ID 不再偷偷替换批准内容。
- 自有 POSIX 进程组采用共享关闭 Promise，主进程退出后继续检查组内进程并保留 SIGKILL 升级；清理失败保持不确定态，不报告已停止。
- turn 报告和下一代派发等待进程清理；并发 stop 共用清理与停止 Promise；旧清理只能移除自己的活动记录。调度器增加每任务在途操作和活动 Worker 检查。
- 本地完成拒绝未结算输入、待决审批和未结束 effect；发布在异步边界重新校验授权 revision、任务终态与停止锁。
- 发布持久化 preflight/commit/push/MR 阶段。确定未开始交付写入的失败或重启中断，作废旧授权并允许重新预览；写阶段或旧记录阶段未知时仍要求核对。
- GitLab 迁移前 `npm --prefix packages run check`：**33/33 测试通过**，包括新增 14 项回归测试。真实本地 Node 进程覆盖主进程先退出、TERM-resistant 子进程与进程组回收；临时真实 daemon 覆盖前置失败恢复和同任务串行派发；执行器关闭等待与交付交错场景使用模拟对象。原 GitHub fixture 已转换为 GitLab MR fixture。

重复压力检查中有一次进程测试因主机于 12:26:32–12:32:51 休眠而触发 15 秒超时（电源日志确认休眠 379 秒）。唤醒后两项进程测试重跑通过；最终全量检查使用临时 `caffeinate -i` 避免空闲休眠，未修改系统电源配置。

以上证据不等于真实 Codex Worker、逃逸进程树或 GitLab 网络写入验收。P0 执行门禁和 GitLab 默认关闭保持不变；没有执行模型 turn、真实 push/MR、安装插件或修改用户认证。

## 已执行检查

- 多任务改造前，GitLab 迁移检查为 **46/46**；本轮新增协调、计划、调度、基线、恢复与安全用例，最终数量和证据见本节后“多任务恢复验收”。历史 46 项不是新增功能的验收证据。
- `npm --prefix packages run probe`：本机真实 App Server，无模型调用；隔离账号未认证，`modelTurnTested=false`，配置回读不等于文件系统隔离验收。
- 临时 Git 工作树测试：原 checkout 不变，固定 base、分支归属、危险目录与符号链接拒绝。
- 真实本地 MCP transport：工具数量/允许列表、重复写幂等、人工授权、暂停不派发、停止持久化、备份与服务重启。
- GitLab fixture：未跟踪文件纳入预览、审批后修改拒绝、一次创建、远端 head/仓库校验、反馈去重、响应丢失核对、不解除停止。
- 安全检查：非交互批准拒绝、错误 token/admin 分权、profile 篡改拒绝、锁所有权、回环看板 Host/Origin/会话与只读 API。
- 独立进程 SIGKILL 后重新打开 SQLite：已提交 WAL 数据保留，sending 输入及 running effect 转为待核对，没有自动重投；这不是 Codex 真实 turn 恢复验收。
- npm 包在临时目录安装，仅生产依赖即可启动 CLI help；插件副本在临时目录生成并通过验证，未执行全局安装。
- 本地 plugin-creator、skill-creator 验证器校验 manifest 与 Skill。Python 校验依赖装在临时 venv，没有修改全局 Python。

检查不是生产安全认证。旧根项目 `pnpm check` 所需的 DSH/pnpm 环境未在本次安装，不能把新包检查称为全项目检查通过。

## 2026-11-17 多任务恢复验收

- 按 010 的“先恢复原有协调，再扩展 DAG”顺序实现；009 不再把主 Agent 的关联/路由一并排除。未修改原 `src/`、原 `tests/` 和提示词基线，保留此前 GitLab 迁移及 review 修复。
- `npm --prefix packages run check`：**77/77 通过**（GitLab 迁移后的 46 项继续通过，新增 31 项）。包含后端/面板 TypeScript 和生产看板构建。
- 原有能力恢复：Thread 多对多订阅、context/owning、correlation 仅提供证据、多任务去重 fan-out、相关任务读取、逐项路由拒绝与重放、所有权退回、unrelated 原子退订/退回、人工唤醒保留槽及非重复容量计数。
- 扩展验收：环/悬空/重复边拒绝、菱形汇合、图 revision/指纹/期限/预算、结果版本检查、资源冲突、优先级与老化/同级公平、失败分支隔离、显式计划内重试、组停止/恢复不解除个人 hold、整体验收前置检查。
- 真实本地 daemon + Unix socket + SQLite，假 Worker：两个根任务实际并发派发，均验收后仅派发一次 integration，可信验收后完成计划并重启保留。看板 HTTP 返回完整任务图且拒绝写入；这不是浏览器人工视觉验收。
- 真实临时 Git：两个上游 commit 在下游同一固定基线可见；不复制用户未提交文件；缺失祖先/未合并提交拒绝；GitLab MR 精确 merge SHA 与代码依赖绑定。
- 独立进程 SIGKILL：图与授权保留，运行资源转不确定态，不能因 lease 到期重派；人工核对后仍保持任务 hold。schema 1 备份迁移保持原任务和待决审批。
- `git diff --check`、Markdown 本地链接/代码围栏、Skill 官方本地验证脚本通过。Skill 校验缺失的 PyYAML 仅通过临时 `uv run --no-project --with pyyaml` 提供，没有改项目依赖或全局 Python。
- npm 打包 dry-run 核对包含协调/调度模块、GitLab 适配器，不包含测试、旧 GitHub 适配器、token 或数据库；未发布 npm 包，未安装或重新安装 Codex 插件。

本轮没有真实模型 turn、真实 GitLab API/push/MR、用户认证导入或远端修改。真实执行门禁仍关闭。当前工作保存在 Git 工作树中，未自动 stage/commit；包括用户此前尚未提交的改动，不替用户混合提交。

## 明确限制与下一步

1. **先做 P0，不直接打开门禁。** 用户需明确选择 Worker 的模型和独立认证方式；不能复制主会话的 auth 文件。使用专门临时仓库验证读取服务 token、其他任务文件、用户 home、共享 Git 元数据都被阻断。若无法实现，改用受限 OS 账号/容器。
2. 验证请求审批的具体 payload、返回值、超时/断连失效、终止真实子进程树，然后补 `turn/steer` 和持久线程核对。当前 Runtime 权限扩张只能拒绝，不能审批放行任意 shell。
3. `reconcile` 是人工审计入口，不是自动恢复证明：必须自行核对进程、线程、输入、工作树后明确选择 `settled` 或 `pending`；恢复后仍处于 humanHold，需要再次申请 resume。
4. Worker 输出中的 checks 是声明，不冒充独立测试结果。无 MR 的 ready 结果由人执行 `complete` 接受交付；MR 的 ready 不代表合并。
5. MR 反馈按“不可信外部输入”记录，默认要求范围复核后显式 resume。暂不自动对评论判断范围，也不把反馈当授权。
6. 发布 SHA 已知且唯一 MR 匹配时可核对落库；若 Git push 成功但 MR 未创建，或写阶段没有持久 commit 核对点，则保持待核对，不执行通用重试。明确停留在 preflight 且无 commit 核对点时，可以作废旧授权并重新预览。
7. 同一 OS 用户的任意恶意进程仍可攻击用户自己的文件；0700/0600/Unix socket/CLI TTY 不是对同用户任意代码的安全沙箱。Worker 安全取决于尚待验证的隔离边界。
8. 控制台支持登录后的人工审批与控制，macOS 本机实例使用用户 LaunchAgent 常驻；不提供远程多用户服务。账号可用性和 usage 未验证时显示 null/未知，不填伪造的 0。SIGKILL 后残留锁仍需人工核对恢复，不能把自动拉起解释为自动解决不确定操作。

## 2026-11-17 全局插件与网页控制验收

- 按 011 增加本地逐项审批、完整上下文预览、ID 确认、一次性 reviewId、CSRF 和重新登录失效；发布仍绑定既有 fingerprint，runtime 权限扩张仍禁止批准。
- 任务启动/恢复/重试/停止，计划启动/暂停/停止，结果和整体验收均调用原有严格参数、版本、预算和停止规则；没有通用网页管理 RPC 或公开 MCP 审批工具。
- `npm --prefix packages run check`：**85/85 通过**。新增 HTTP 用例覆盖未登录/跨源/CSRF/超长/未知请求、计划批准、预览变化/过期/重放、停止与版本冲突、ready 结果/整体验收、代码依赖拒绝和令牌文件权限。
- 真实 Chrome 临时仓库验收：登录、完整审批预览、无 ID 不能批准、逐项批准、计划暂停、390px 移动端无横向溢出和无脚本错误。仅使用临时测试实例的令牌与计划，未读取实际实例登录令牌、未审批真实工作。
- 实际执行 `codex plugin add superagent@personal --json`；`codex plugin list --marketplace personal --json` 确认 installed/enabled。缓存 manifest 的绝对路径 bridge 从 `/tmp` 工作目录完成 initialize、26 tools/list 和 health；无管理审批工具，绑定 `insight-plugins1`。
- 实际实例已托管为 `local.codex-superagent.insight-plugins1.service` 与 `.panel` 两个用户 LaunchAgent，当前存活；控制台 `http://127.0.0.1:43187` 直接回环 HTTP 200。日志不含登录令牌，私有文件供用户自己在可信终端读取。初次启动需要等服务 socket 就绪；本机代理需绕过回环地址。
- 未调用真实模型、未启用 GitLab 写入、未复制账号认证、未修改目标仓库代码或远端，未提交 Git。全局插件与托管配置是用户授权的本机安装变更，不属于仓库分发包。

## 2026-11-17 会话项目绑定修正

- 用户明确纠正“全局插件固定指向 insight-plugins1”。按 [012](012-session-project-binding.md) 改为会话级 project_open、每项目独立服务；无 --state 的 bridge 默认不绑定任何仓库，显式 --state 仅保留为兼容模式。
- 新增 6 项测试：两个客户端 A/B 隔离、同项目复用、未选项目拒绝、roots 校验与变更拒绝、首次初始化/模型要求、错误映射和残留锁拒绝、并发初始化单次启动、独立面板与私有令牌、进程 cwd 不作为项目来源。完整测试 **91/91 通过**，真实 Worker 门禁未改变。
- 已授权更新用户级插件并重装为 `0.1.0+codex.local-20261117-094131`。安装时 plugin-creator 辅助脚本路径已不可用，沿用其已读取的 cachebuster 规则并交由 `codex plugin add` 校验安装；未手动改写 marketplace 或 Codex 全局配置。
- 实际缓存插件从不同 cwd 建立两个 MCP 连接：未选择时均为 PROJECT_REQUIRED；显式选择当前源码项目与 insight-plugins1 后分别返回对应仓库、独立 state 和控制台、27 个公开工具。旧实例 ID 保持不变，没有数据库搬迁或默认仓库。
- 当前源码项目仅初始化了协调服务及独立控制台，没有创建/批准任务，没有模型 turn 或 GitLab 写入。模型沿用本机已登记名称；不复制 provider/auth 配置。项目模式的普通任务工具不启动服务，必须显式 project_open；无法取得可靠会话路径时询问用户，不假称所有宿主都提供 roots。
- 本机新会话需重新发现新缓存版本；当前已打开的会话不冒充已热更新。旧 `43187` 面板仍只属于 insight-plugins1，其他项目以 project_open 返回的地址为准。

运行步骤见 [Codex 使用说明](codex-usage.md)。

## 2026-11-17 任务驾驶舱与调整回归验收

- 按 [013](013-task-cockpit.md) 实现以计划为中心的控制台：可点击分层 DAG、默认每页 10 条的任务筛选与搜索、独立审批中心、折叠底层审计；审批列表展示任务或计划名称。
- 阶段性进展、结构化报告与失败记录持久化，保留范围和执行轮次。调整后列表与时间线显式标记历史，旧计划版本的结论不会冒充新范围成果；已合并但待结果验收的任务仍在待处理视图中。
- `task_adjust` 支持调整范围、名称、优先级及资源，撤销旧授权并保留独立人工停止。计划成员调整后整组重新审批，不扩大尝试预算。新增回归覆盖：旧执行资源在停止和恢复核对期间不提前释放；已有验收产物保留，后续调整不妨碍整体验收。
- `npm --prefix packages run check`：**106/106 通过**；`git diff --check` 通过。测试覆盖闭门禁不消费已授权 effect、分页计数、DAG、阶段结论去重与重启持久化、版本冲突、调整撤权、依赖验收、HTTP 登录与 CSRF。
- Chrome 临时合成实例验证：登录、三个节点与两种依赖、阶段结论时间线、追加说明、暂停调整及撤销整组授权、历史标识、10 条分页、名称搜索、390px 移动端无横向溢出、无浏览器脚本错误。未读取实际项目的面板令牌，未审批真实任务；页面验证不等于真实 Worker 验收。
- 当前源码项目的真实 `worker-check`：版本兼容、握手与限制配置读回通过，`accountConfigured=false`、`modelTurnTested=false`。真实执行仍有五项验收未完成：隔离、审批回路、取消、恢复与独立认证模型调用。没有复制主会话凭据、发起模型 turn 或打开门禁。
- 确认当前源码项目没有任务、运行 Worker 或不确定 effect 后，已刷新该项目 daemon 与控制台；保留既有 state，未重启其他项目。面板地址以该项目 `panel-session.json` 或下一次 `project_open` 返回值为准，登录令牌随重启轮换且仅供用户在可信终端读取。已连接 MCP 会话不冒充热更新，新工具需要新连接发现。
