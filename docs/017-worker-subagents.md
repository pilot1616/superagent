# Worker 内受控多 Agent 协作

## 1. 目标与层次

Task/Ticket 是持久业务任务；Assignment 是它的一轮执行；Worker 是该轮独占的 Codex App Server 进程。增加 Worker 内的主 Agent 与多个子 Agent，不把子 Agent 当成新的 Ticket，不增加任务图节点，也不赋予它们协调服务的管理权限。

```text
项目协调服务 → Task → Assignment → Worker
                                 ├─ 主 Agent：分工、集成、最终结构化报告
                                 ├─ 子 Agent：分析/实现局部工作
                                 └─ 子 Agent：审查/验证
```

使用固定版本 `codex-cli 0.154.0-alpha.6.2` 的原生 multi_agent 工具，不自行伪造模型对话。v1 主 Agent 可 spawn/send_input/wait_agent/close_agent；v2 使用 spawn_agent/send_message/followup_task/wait_agent/interrupt_agent/list_agents，没有独立 close_agent，统一随 Worker 清理。子 Agent 继承父级沙箱与认证，通过原生工具返回结果。不同 Ticket 间仍通过共享线程、定向说明与验收结果交接，不能跨任务直接操作别人的 Agent。

## 2. 配置、授权与容量

- 新建 Worker profile 默认启用；`agents.enabled=false` 可关闭。旧 profile 缺少 agents 字段时仍按关闭处理，不静默更改运行环境。
- `agents.maxConcurrent` 为每个 Worker 的子 Agent 并发上限，默认 3、范围 1–4；原生 `agents.max_concurrent_threads_per_session` 执行限制。`maxDepth=1`，不允许子 Agent 再生成孙 Agent。
- 同时开启原生 `multi_agent` 与 `multi_agent_v2` 开关，由固定版本按模型目录选择原生协议；两者使用同一父子线程事件适配器。模型必须支持对应原生工具且子模型在 Codex 支持目录中；不悄悄替换模型，未知模型可能收到原生工具不可用或 spawn 拒绝。开关与 agents 配置纳入有效配置检查、profile hash、诊断指纹及人工启用预览。
- 配置变化需要停止协调服务后执行 `runtime configure-profile --json`，再启动、诊断和人工启用。任务原有审批、依赖、资源锁、暂停与停止保持有效。子 Agent 不获得额外任务授权。
- 一个 Worker 最多记录 32 个不同子 Agent；超过记录界限或观测到越层、越并发行为则失败并统一清理。并发上限不是费用上限；多 Agent 会增加模型调用，仍不承诺强制 token/费用预算。
- 项目并发继续计算 Worker 槽位；最大模型会话规模按 Worker 并发 ×（1 + 子 Agent 上限）估算，不把子 Agent 当免费槽位。

## 3. 工作区与权限

一个 Ticket 仍只有一个 worktree/任务分支。该 Worker 的所有 Agent 共享此工作区，不自动创建子 Agent 分支，也不自动合并。主 Agent 必须给并行实现划分不重叠的文件写集；不能拆开的修改串行处理。该约束是执行指令，不是自动文件锁；需要强隔离、独立审批或跨分支开发时必须拆成不同 Ticket。

子 Agent 继承原生父级权限：工具网络关闭，状态目录与用户目录禁止访问，插件/MCP/远程控制关闭，不能提交、推送或发布 MR。权限扩张请求仍不能自动批准。服务只接受来自当前 Worker、当前 Assignment、已登记子线程/turn 的提问与审批，拒绝其他线程、过期轮次和跨任务请求。

## 4. 原生通信与状态记录

主 Agent 使用模型所暴露的原生 spawn、消息、等待和停止工具与子 Agent 协作。这里是同一 Worker 内的原生通信，不改变外部 `task_message` 下一轮消费的语义；兄弟 Agent 的消息能力由原生协议决定，仍限制在本 Assignment 的已登记线程中。

服务从 `thread/started`、`turn/started`、`item/started/completed`、`turn/completed` 和父线程的 `collabAgentToolCall` / `subAgentActivity` 记录子 Agent。v2 可能只发父线程的 activity 而不发子线程 started，使用当前父轮次的原生 activity 与单层 task path 登记，再以 `thread/read` 核对父线程和 cwd，读取可用的分工预览；元数据检查完成前不能接受主报告。按 Assignment + 子线程 ID 持久化父子关系、角色、状态、分工摘要、最新结论和清理状态；去重，限制文本和记录数量，不保存 reasoning 或工具原文。未知线程不能冒充已登记子 Agent，迟到通知不能改写已结束执行。

`task_get` 与任务详情展示这些记录，历史轮次标为历史。子 Agent 的结论仅供主 Agent 综合，不能写入 Task 的最终报告、完成任务或解锁下游；只有主 Agent 的结构化报告和现有人工验收流程有这些职责。

固定版本在发出子 Agent started 后，rollout 元数据可能尚未写入。仅对 `thread/read` 的临时内部错误做最多约 5 秒的有界只读重查，取消时退出；不重发 spawn、模型 turn 或任何状态修改，不把读取失败当作已验证。

## 5. 停止、异常与恢复

人工停止、任务范围调整、服务关闭、超时与主 Agent 完成均走同一个 Worker 清理路径。先结束 App Server/已观察进程组，再释放 Worker 槽位、工作区临时文件和任务资源。子 Agent 不能脱离父 Worker 常驻；主报告只有在统一清理成功后才可入库。

清理成功时记录 closed；不能确认时记录 uncertain，并沿用 runtime quarantine 与任务 reconciliation，不能标为已安全停止。服务重启把未确认关闭的子 Agent 记录改为 uncertain，不自动恢复子 Agent 或重放消息。

本机并行执行时，macOS 对已经消失的进程组可能返回 `kill(0) EPERM`。只有独立系统进程快照确认进程组不存在、且既有后代检查也通过时才视为关闭；仍有组成员、观测失败或后代存活一律保持不确定，不能直接忽略 EPERM。

## 6. 验证与边界

测试覆盖配置上下限、旧 profile 兼容、真实固定版本配置握手、父子注册与去重、并发/深度防线、原生消息状态、外来/旧 turn 拒绝、子 Agent 提问、结果隔离、停止清理与重启恢复，以及控制台展示。可用 loopback 模型 fixture 验证真实 Codex 的 spawn 与返回链路；fixture 不等同于真实账号、外网模型或生产环境验收。

不自动迁移现有 profile、不替人登录/审批、不重启其他项目，不把未经验证的 token/权限能力宣称为已支持。

官方参考：<https://developers.openai.com/codex/multi-agent/>、<https://developers.openai.com/codex/app-server/>。当前官网配置会持续演进，具体字段以固定版本的配置握手与生成协议为准。
