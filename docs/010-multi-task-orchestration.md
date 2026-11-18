# 010 关联多任务编排与调度设计

> 日期：2026-11-17。状态：修订后的实施契约；实现证据见实施记录，不代表真实模型或 GitLab 生产验收。
> 补充并修订 [009](009-codex-plugin-design.md)：产品主要管理一组相互关联的任务及其调度，单任务 Worker/MR 流程只是底层能力。现有安全门禁、人工授权、单仓库边界和 GitLab 交付约束不变。

## 1. 目标与当前差距

系统要回答的不只是“任务 A 进行到哪里”，而是：当前哪些任务能运行、哪些必须等待、等待谁或什么资源、失败影响哪些任务、上游变更后哪些结果失效，以及整个目标何时可以交付。

改造前审计依据：新运行时的 Ticket 没有任务关系，daemon 的 tick 仅派发 effect 和限制并发。因此“支持多个 Ticket”和“支持关联任务编排”是两种不同能力。修订后的实现位置与接口契约见第 9 节；验收结果单独记录。

此前 46 项测试只能证明旧开发预览的能力；本轮必须增加协调层、任务图、调度与重启测试。先恢复原有行为，再落实有界依赖调度；原 `src/` 和原测试保留作为对照基线。

### 1.1 原有核心的恢复清单（不得以 DAG 替代）

| 原有语义及依据 | 新运行时必须提供的等价能力 |
| --- | --- |
| `src/core/model.ts` 的 Thread/Subscription/Correlation | 持久化 Thread、事件、任务多对多订阅，区分 owning/context；关联仅增加证据、不隐式路由 |
| `src/core/intake.ts` 的去重与 fan-out | 一个事件向所有有效订阅任务分发一次；停止任务不接收；上下文订阅不授权、不恢复 |
| `src/app/tools/main.ts` 的 route 与关联上下文 | 主会话读取候选事件和已有相关任务；批量 accept/attach/ignore/stop，每项独立校验并记录结果，重放不重复建单 |
| `src/core/tickets.ts` 的 follow/unrelated/handback | 显式订阅和取消上下文订阅；消息退回后可重新路由，保留原始输入和历史，不撤销已送入模型的事实 |
| `src/executor/dsh.ts` 的 WorkerSlots | 按任务去重统计启动/活动/清理占用，人工跟进唤醒优先于新任务，最多一个保留唤醒槽位；CI/context 不能占用该槽位 |
| Effects、Assignment 与恢复 | 同任务串行、持久输入、旧代次回调拒绝、不确定执行和资源占用必须核对后释放 |

不恢复飞书、全库主动接单、自动合并或 DSH 子 Agent 管理。原有“人工消息恢复已结束任务”适配为显式恢复审批，外部消息不能解除 hold；这不影响上下文关联和分发。

## 2. 主流程与示例

```text
用户目标 / 批量任务
       ↓
提出拆分、依赖、验收条件、资源声明
       ↓
人工确认版本化任务图与有界执行授权
       ↓
调度器计算可运行集合 → 按优先级和容量派发多个 Worker
       ↑                               ↓
       └── 状态事件 / 验收结果 / 资源释放 ─┘
       ↓
集成任务与整体验收 → 人工确认整体交付
```

例如“新增订单管理”：

```text
A：确认接口契约
├─ B：实现后端 ─┐
└─ C：实现前端 ─┼─ D：联调与集成测试 → E：交付验收
               ┘
```

A 的已验收契约交接后，B/C 可以并行；D 只有在 B/C 对应版本的代码都已进入可用集成基线后才能执行。另一个无关任务 F 不因 B 失败而被整体阻塞。示例只是关系语义，不自动创建任务、调用子 Agent 或开展实际发布。

## 3. 领域结构与关系

| 概念 | 设计职责 |
| --- | --- |
| TaskGroup / Plan | 共同目标、必需任务集合、验收条件、图版本、计划授权、集合暂停/停止与预算 |
| Ticket | 保留现有执行单元，增加所属集合、优先级、资源声明、输入/结果版本 |
| Dependency | 有方向的硬依赖：消费者、生产者、所需验收条件和结果版本；阻塞消费者派发 |
| Relation | 第一版以 Thread.correlated、订阅和任务集合归属表达非依赖关联；无通用父子树或任意 related-to 编辑器，不把上下文关联当成先后依赖 |
| ResourceClaim | Ticket.resources 声明的资源名；从持久 Assignment/effect 的运行、停止和不确定状态投影占用，在 claim 事务内再次互斥校验；不是 OS 文件锁或自动代码冲突检测 |
| AcceptedResult | 已验收的不可变产物引用、版本/哈希、代码 SHA、检查证据和验收主体 |
| SchedulingDecision | 就绪/等待原因、依赖版本、排序与资源分配、派发结果的可审计记录 |

硬依赖采用 DAG：拒绝自身依赖、环、缺失节点和跨未登记仓库关系。归属、普通关联及资源互斥不计入 DAG；父子关系本身不隐含执行顺序。

第一版仅支持同一集合内硬依赖；独立工作可使用不同集合。跨集合引用和跨仓库依赖暂不开放，避免隐式扩大授权与停止范围。

每个任务只有一个不可变验收结果，同一生产者的所有出边必须使用同一种验收条件；同时需要独立契约和代码时拆成不同任务。所有必需任务必须通过依赖路径到达 integrationId，避免“整体验收”漏掉独立分支。

新增领域结构要有显式存储版本与备份迁移测试；旧 Ticket 保留身份、审批及人工停止状态，不从历史 `completed` 自动构造“成功产物”，也不自动获得集合级执行授权。

## 4. 调度规则

每个状态变化触发调度评估；周期扫描用于兜底恢复，不能只依赖内存事件。

一个任务只有同时满足以下条件才可派发：

1. 任务、所属集合和服务允许派发，且不处于 humanHold、停止或待核对状态。
2. 当前任务版本、范围、依赖输入和预算在有效的显式授权内。
3. 所有硬依赖满足各自验收条件，所引用产物/集成基线可用且版本仍匹配。
4. 没有属于该任务的活动 Worker、未清理进程或互斥的在途副作用。
5. 所有必需资源能原子取得，且执行容量和预算允许。

通过筛选的候选任务按明确优先级、等待老化和稳定的创建顺序择取；设置集合级公平规则，避免某个大集合占满所有槽位。关键路径优化可后置，不能先于基本正确性。

容量与资源必须分开计数：运行/启动中的 Worker 占执行槽位，观察任务与发布 I/O 不重复计为 Worker；停止、回收和核对不能因执行队列已满而饿死。某任务资源不可用时继续考察其他候选，不能堵住整个队列。

在单写者事务内重新检查任务/计划版本与依赖，原子占用资源并建立带 generation 的 launch effect。实际 launch 前再次验证；过期计划不能沿用旧候选决策。保留现有副作用持久化、幂等和每任务串行约束。

UI/API 分开提供执行阶段与 scheduling 状态，至少解释 `waiting_dependencies`、`waiting_authorization`、`waiting_resources`、`ready`、`paused`、`held`、`reconciling`，并列出具体阻塞项；不要把所有不能运行的任务都显示成 queued。

## 5. 结果交接与代码基线

**上游结束不等于依赖满足。** Worker 自报 ready 只是报告，不能代替验收；停止、失败、关闭未合并 MR 也不能满足成功依赖。现有 GitLab 观察把某些 closed/merged MR 都收束为任务终态，这一终态不可直接用作下游解锁依据。

第一版区分两种交接条件：

- 契约/文档/测试数据：由明确的人工验收记录接受不可变产物，并将引用和哈希交给下游。外部内容仍是数据，不是新的权限指令。
- 代码依赖：默认要求上游 MR 已由人合并到登记的目标分支，记录实际合并后的 commit；验证该 commit 已包含在下游将使用的基线内。不能只读取 MR 标题、状态或源分支 head 就假定代码存在。

下游 worktree 必须基于所需代码实际可见的固定 SHA 创建，并把输入结果版本、实际 base SHA 写入 Assignment/授权上下文；不能继续无条件复用服务初始化时的旧 baseSha。多个上游必须同时包含于该基线。

第一版不自动跨 worktree 复制未提交文件，不自动 cherry-pick、不做 stacked MR 或自动合并；需要这些更激进的交接方式时另行设计冲突处理和授权。B/C 并行开发可以独立，但 D 需等待两者均进入已验证的共同基线。

发布审批继续绑定实际 diff/head/base/作者/说明；任何基线调整不得复用旧发布指纹。最终必须有显式集成任务与验收，不以“每个 Worker 都完成”替代整体正确。

## 6. 计划授权与图变更

新增“有界计划授权”：人通过可信入口确认具体图版本、任务范围、依赖验收条件、输入基线规则、每任务执行次数上限、有效期和重试政策。计划范围内的依赖满足后自动派发，不必逐项 start。第一版预算是执行次数和到期时间，不伪称 token/费用预算；失败重试仍需显式请求，但可以使用计划批准的剩余次数。

这不是无界授权。执行授权和发布授权保持分离；修改未执行计划的依赖/资源/优先级作废旧授权；已执行计划不得原地扩张或增加预算。Codex 可以提出新计划或未执行计划的变更，但不能自行批准。

修改图时原子校验版本与环并作废旧授权。第一版拒绝集合已有执行历史、已验收结果或未结算外部副作用时的图变更，不实现运行中热改图或静默重基线。未运行任务的优先级/资源与依赖可在重新授权前更新；增删任务通过新计划创建，不原地扩张已执行计划。派发绑定不可变输入结果和固定代码 SHA，报告与发布前再次验证。

单任务停止只影响该任务与依赖它的可运行性；无关分支继续。集合暂停禁止新派发但不终止活动任务；集合停止先持久化集合及目标任务的停止意图，再取消并等待回收。恢复集合不得清除原先独立设置的任务 humanHold。

GitLab 评论/CI 输入不修改图、不扩大授权，也不能解除人工停止。需要范围变化时进入显式计划修订。

## 7. 失败、恢复与整体状态

- 上游失败时，未执行的依赖分支等待并列出失败根因；不把所有下游都伪标成执行失败，无关分支继续。
- 重试只针对指定失败任务，并受计划内重试次数和预算限制；新结果经验收后重新评估相关下游，不默认重跑整个集合。
- 资源租约和占用记录需持久化；服务重启后先核对旧 Worker/外部写入，不能仅因租约到期就把仍可能占用的资源交给新 Worker。
- 发布、推送和模型输入结果不明确时保留 reconciling；不以重试调度为名重复外部副作用。
- 集合视图展示运行、等待依赖、等待授权、资源等待、失败、停止及待核对的数量和节点，不用单个“进度百分比”掩盖问题。
- 仅当所有必需任务有有效验收结果、集成验收通过、没有未结算副作用/待核对事项且不处于人工停止时，才能确认集合成功。集合停止为 stopped、Worker 放弃而缺结果为 incomplete、部分验收为 partially_accepted；都不是 completed。改变必需任务集合需另建计划，不能把 MR 关闭等同于成功。

## 8. 代码改造边界与实施顺序

| 阶段 | 主要改造 | 最小验收 |
| --- | --- | --- |
| M1 任务图与持久化 | core 模型/命令、storage 版本迁移、原子建图与图版本审计 | 创建集合、依赖增删、环/悬空边拒绝、并发图修改冲突、旧记录保留停止/审批语义 |
| M2 就绪与派发 | 独立 scheduler 模块、daemon 调用、执行容量与资源声明/租约、公平排序 | 链式、分叉/汇合、菱形依赖、优先级老化、无关分支并行、资源竞争、重复派发拒绝 |
| M3 验收与结果交接 | 结果契约、GitLab 合并证据、workspace 固定基线、过期结果检查 | 未合并 closed 不解锁、上游代码在下游可见、多个上游共同基线、图/输入变化不复用旧授权 |
| M4 计划授权与操作入口 | 有界计划授权、集合暂停/停止/恢复、CLI/MCP/Skill、只读图和阻塞原因 | 一次有效计划授权内自动连续调度；越界变更重新审批；集合恢复不解除独立任务停止 |
| M5 恢复与整体验收 | 持久资源核对、故障注入、集成任务和集合完成判定 | 派发/资源取得间崩溃、运行时重启、上游重试、失效结果拒绝、MR 反馈不能自授权、整体交付闭环 |

先用确定性假执行器验证任务图调度及崩溃边界，不依赖真实模型才能发现调度错误；真实多 Worker 和 GitLab 联调仍必须通过 009 的 P0/P2/P4 安全与外部验收。禁止用“计划需要并行”作为绕过执行门禁的理由。

原生 DSH 的 turn 内实时输入投递不直接照搬：新执行器仍在安全门禁下，运行中新增输入持久排队，在清理完成后通过下一 Assignment 消费；上下文和外部反馈不会自行唤醒。这一执行适配限制必须在使用说明中公开。

## 9. 确定的实现契约与接口

### 9.1 模块与事务边界

- `core/src/model.ts`：Thread、TaskEvent、Plan、Dependency、AcceptedResult；Ticket 增加 planId/priority/resources/result，Assignment 记录图版本、输入结果快照及实际 baseSha。
- `core/src/coordination.ts`：关联上下文、逐项路由、手动退回、建图与更新、计划审批、结果验收和整体完成。复用 Engine 的任务命令，不在 MCP 中另写数据库。
- `core/src/scheduler.ts`：就绪理由、运行资源占用、按任务去重的 Worker 容量、人工保留槽、优先级/等待老化与同优先级集合公平选择。daemon 每 100ms 兜底评估，状态变化才写 scheduler.decision 审计，不逐 tick 写重复事件。
- `storage/src/store.ts`：schema 2 新增通用 entity 表保存 thread/event/plan；Task/Assignment/effect 的事务语义保持原样。schema 1 升级前生成 `tasks.sqlite.before-v2.sqlite` 一致性备份，事务内建表与升版本；旧任务、审批、hold 不改写、不自动归组。配置版本仍为 2，配置版本与数据库版本是独立概念。
- Worker 槽位仅计启动/活动/清理/不确定执行的唯一任务 ID；发布与观察不占 Worker 槽位，但发布仍占用本任务声明的互斥资源。资源不得因 lease 到期自动释放。
- 同一调度轮也不能选择资源冲突任务；claim 再次从持久状态检查，阻止陈旧候选双派发。停止操作先于新的 launch，不受正常执行容量限制。

### 9.2 公共操作（CLI / MCP）

CLI 使用 `task|thread|event|route|plan OPERATION --json '…'`，对应 MCP `superagent_<前缀>_<操作>`。所有写操作必须有 requestId；对象变更使用 expectedRevision。未知响应重用原 requestId 与参数，不以新 ID 盲目重试。

| 操作 | 主要字段与行为 |
| --- | --- |
| thread_create / thread_get / thread_list | title；threadId；列表和事件使用 cursor/limit 分页 |
| thread_subscribe | threadId、expectedRevision、ticketId、mode=owning/context/remove；源线程/绑定 MR 订阅不能降级或删除，删除普通订阅不抹去旧输入所有权 |
| thread_unrelated | threadId、expectedRevision、ticketId、expectedTicketRevision、reason；原子取消非源线程订阅并退回其所有 owned follow-up，任一退回失败则整次回滚；对应原 markUnrelated |
| event_record | threadIds、text、source=manual/gitlab；一次多线程事件去重投递，owning 覆盖 context；correlated 只作证据。source 不授予权限 |
| route_context | eventId；返回事件、线程和最多 100 个相关任务及 relatedCount，提示是否仍被其他任务拥有 |
| task_route | items 数组，每项 eventId、kind=accept/attach/ignore/stop、reason；accept 需 title，attach/stop 需 ticketId/expectedRevision。单项失败回滚并记录 refused，不阻断其他项；accept 只建草稿 |
| task_handback | ticketId、expectedRevision、eventId、reason；仅当前 owner 可退回一次，所有 owner 都退回后才可新建/转接；原始任务范围不可作为 follow-up 退回。发送中/运行中先等待核对或清理；保留已结算记录，取消没有有效待处理输入的排队唤醒 |
| plan_create | repositoryId、title、tasks[{key,title,request,priority,resources}]、dependencies[{before,after,condition}]、integrationKey、maxAttempts、expiresAt；返回 key→ticketId 的 mapping |
| plan_get / plan_list | 详情返回图、每个节点执行阶段与 scheduling/reasons、计数和待决审批；列表分页 |
| plan_update | planId、expectedRevision、dependencies（使用真实任务 ID）、tasks[{ticketId,priority,resources}]、maxAttempts、expiresAt；仅执行前更新，不改变任务 scope 或原地增删节点 |
| plan_start | planId、expectedRevision；请求一次图版本、预算、任务范围绑定的人工审批，也用于整组停止清理后的恢复授权 |
| plan_pause | planId、expectedRevision、paused；只影响新的执行派发，不结束活动任务 |
| plan_stop | planId、expectedRevision、reason；先持久化停止，取消未完成节点；记录集合拥有的停止锁，后来的单独停止不再由集合恢复清除 |
| task_retry | 独立任务沿用人工审批；计划任务允许在已有有效授权和剩余次数内显式重试。失败不自动循环重试，不确定态不能走此入口 |

任务报告是 Worker 的声明，不是事实验收。已接受结果不能重新执行或追加需求；人为 hold 后显式恢复仅解除结果的停止状态，不重新运行生产者。已完成集合不可再修改成员状态，后续工作创建新计划。

### 9.3 可信管理操作

- `approve ID` 展示计划完整 spec 与 fingerprint；提交 displayed fingerprint，服务在事务内重新计算并校验图版本和 revision。公共 MCP 不提供 approve、accept-result 或 complete-plan。
- `accept-result --json '{"ticketId":"…","expectedRevision":1,"kind":"artifact","content":"验收产物或证据"}'`：交互确认实际结果后记录不可变内容/哈希。kind=code 时由服务校验绑定 MR 的 mergedSha 确实在登记本地 baseRef 的祖先链上，不能让调用者任意指定 SHA。
- `complete-plan --json '{"planId":"…","expectedRevision":1}'`：交互确认整体验收，所有节点（含 integrationId）都有有效结果且无未结算输入/审批/副作用才成功。
- GitLab merge_commit_sha 优先，随后 squash_commit_sha，快进合并使用已验证 MR 的源 SHA；仍需本地祖先校验。需要的提交未拉取时拒绝并要求操作者显式更新本地基线，不自动联网拉取、checkout 或 cherry-pick。
- 发布预览和每个异步发布阶段继续检查任务授权及依赖结果快照；新发布仍需独立 diff 指纹审批。

### 9.4 必须通过的验收映射

| 恢复/扩展项 | 可执行证据 |
| --- | --- |
| 原有 fan-out、关联不路由、所有权、逐项路由/退回、停止不接收 | `packages/tests/coordination.test.ts` 的订阅/路由/handback 用例；不依赖 DSH |
| 图校验、菱形汇合、一次授权连续执行、输入快照、失败/重试、预算、资源、人工保留槽、公平性 | 同文件的 graph/scheduler/approval 用例 |
| 真实 IPC 服务中的并行根节点→汇合→人工验收→整体完成→重启保留 | `packages/tests/coordination-service.test.ts`；使用假执行器，明确不是模型调用 |
| 上游两个代码提交在下游同一固定基线可见，未提交文件不泄漏，未合并代码拒绝 | 同文件的真实临时 Git 仓库/worktree 用例 |
| 中途进程崩溃后图/授权保留、资源不释放、下游不重放 | `packages/tests/recovery.test.ts` 的独立进程 SIGKILL 计划测试 |
| schema 1 备份迁移、原 hold/审批不变 | `packages/tests/coordination.test.ts` 的 SQLite 迁移测试 |
| MCP 不自授权、CLI 无 TTY 拒绝、看板只读、执行门禁未绕过 | `service.test.ts`、`coordination-service.test.ts`、`security.test.ts` 及已有执行器安全测试 |

本地验收通过可证明本文件的协调/调度实现，不代替真实 Codex 隔离、实时 steer、认证执行、GitLab 网络发布或插件安装验收。
# 后续控制入口说明

网页人工审批与任务/计划控制已由用户明确授权，按 [011](011-local-control-panel.md) 实施；本文原“看板只读”验收条款改为“未登录、跨源、无 CSRF 或无显式确认不得写入；MCP 仍不能审批”。调度和结果验收规则不变。
