# Worker 真实执行解锁设计

> 2026-11-18 修订：用户要求移除完整验收前置门槛，现行规则见 [016](016-worker-verification-advisory.md)。本文中的“完整验收通过才可启用”不再适用；其余边界及待验收事项保留。

> 状态：实施中；动态门禁及管理入口已落地，真实模型与多任务验收尚未完成。逐项状态见 [015 实施记录](015-worker-runtime-implementation.md)，不代表已解锁。
> 日期：2026-11-17。  
> 适用范围：`packages/` 中的 Codex 运行时及 `apps/panel/` 控制台，不改原 DSH 运行时。  
> 前置设计：[009 总体改造](009-codex-plugin-design.md)、[010 多任务编排](010-multi-task-orchestration.md)、[011 人工控制台](011-local-control-panel.md)、[012 会话项目绑定](012-session-project-binding.md)、[013 任务驾驶舱](013-task-cockpit.md)。

## 1. 结论与交付目标

当前不能启动真实 Worker，不是 Codex 不支持，也不是插件没有安装，而是项目用固定的未验收布尔值封锁执行，且真实执行链路还存在认证、权限审批和恢复验证缺口。

本次改造目标是：

**让当前会话项目中的多个真实 Worker，在明确受限的权限内并行工作；依赖验收后推进后续节点；用户能看见进展、停止和调整任务；发生异常时不重复执行、不丢失人工控制。**

解锁不是把 `false` 改成 `true`，而是建立以下条件的交集：

```text
真实实现与验收证据有效
  AND 当前项目运行环境就绪
  AND 人工明确启用该项目的执行能力
  AND 当前任务或计划已获得有效授权
  AND 当前节点依赖、容量、资源与执行预算满足条件
  AND 启动前复核仍然成立
  => 允许启动一个绑定当前 assignment 的真实 Worker
```

### 1.1 第一阶段交付边界

第一阶段交付 `restricted_local`：本机、可信代码库、受限工具执行、人工监督的 Worker。

- 允许模型调用、读取本任务文件、修改本任务工作目录、运行预先允许的本地检查、输出进展及结构化报告。
- 允许同项目内多个任务并发，继续使用现有 DAG、优先级、资源锁及验收机制。
- 不允许 Worker 自行审批、调用控制 MCP、读取服务凭据、推送、发布 MR 或合并代码。
- 对沙箱外执行、任意网络、扩大文件访问范围的请求，第一阶段仍拒绝。
- 不承诺能安全运行任意恶意代码、恶意本地程序或任意第三方安装脚本。
- 不把“一个任务成功”当作“多任务系统已验收”。

### 1.2 不在本次范围

- 跨项目 DAG 与跨项目资源调度。
- Windows 的真实进程树与沙箱适配。
- 无人值守授权、自动权限扩张、自动合并 MR。
- 自动导入用户主会话的账号、provider、插件或凭据。
- 借解锁扩大既有任务范围、计划有效期或重试预算。
- 把现有网页登录令牌视为 Worker 模型认证。

### 1.3 本文的约束级别

- “必须”：首版验收条件，未满足不得标记首版完成。
- “可以”：不改变安全边界的实施选择。
- “后续能力”：必须明确显示未开放，不纳入首版已完成承诺。
- 本文中的命令、接口、字段和文件是设计契约；是否已经实现、是否有真实证据，分别以 015 的实施表为准，不以文档示例代替验收。

## 2. 现状审计与根因

### 2.1 改造前已核对的实现（历史基线）

| 位置 | 当前实现 | 问题或限制 |
| --- | --- | --- |
| `executor-codex/src/acceptance.ts` | 五项真实验收固定为 `false`，全部通过才执行 | 无运行时解锁流程，无法随环境变化更新 |
| `service/src/daemon.ts` | 启动时计算 `readiness`、`canLaunch` | 登录、重新检查后仍沿用旧结果 |
| `executor-codex/src/executor.ts` | 启动前再次检查全局静态门禁 | 只修改调度器不能真正解锁 |
| `executor-codex/src/probe.ts` | 握手、配置回读、`account/read` | 只诊断，不执行模型、不验证实际文件权限 |
| `executor-codex/src/profile.ts` | 独立 HOME/CODEX_HOME，限制环境变量、插件及权限 | 配置存在不等于所有工具均在该边界内运行 |
| `executor-codex/src/executor.ts` | `decideRuntime()` 拒绝所有 accept | 未形成可批准的运行时权限链路 |
| `service/src/panel-actions.ts` | runtime 预览 `canAccept=false`，accept 被拒绝 | 不能只改前端按钮来批准权限 |
| `executor-codex/src/rpc.ts` | 创建独立 POSIX 进程组，TERM/KILL 后核对组消失 | 不证明逃离进程组的后代均已终止 |
| `service/src/workspace.ts` | 使用 Git worktree，主 checkout 不直接修改 | worktree 共享 Git 元数据，不是安全隔离 |
| `core/src/engine.ts` | 崩溃后转 reconciliation，人工核对后恢复 | 机制已有，但缺真实 Codex 中断恢复验收 |

### 2.2 最近一次实际诊断

2026-11-17 对当前源码项目执行既有 `worker-check`，结果为：

```json
{
  "version": "codex-cli 0.154.0-alpha.6.2",
  "compatible": true,
  "handshake": true,
  "restrictedConfigReadback": true,
  "accountConfigured": false,
  "model": "gpt-6.1-sol",
  "modelTurnTested": false,
  "filesystemIsolationTested": false
}
```

这是历史诊断快照，不能作为未来启动的实时依据。模型名称也不代表该账号实际拥有访问权限。

此前的 106 项本地测试覆盖状态机、调度、接口与部分进程行为，不能替代真实认证、模型、权限与多任务执行验收。

### 2.3 不应继续沿用的做法

1. 全部能力绑定在一个 `Object.values(...).every(Boolean)` 上。
2. 让高权限批准能力未完成，永久阻塞所有不需要高权限的普通编码工作。
3. 把配置信息回读当成实际沙箱验证。
4. 把独立 CODEX_HOME 当成对同一 OS 用户的完整隔离。
5. 把同一账号已登录主会话，等价为 Worker 已认证。
6. 提供 `--force`、环境变量或网页开关直接绕过验收。
7. 在诊断请求中暗中运行模型、安装依赖或修改用户认证。

## 3. 信任边界与能力分级

### 3.1 信任主体

| 主体 | 可以访问 | 不应拥有 |
| --- | --- | --- |
| 人工操作员 | 本项目管理界面、可信终端、审批与启用操作 | 无需把凭据发送给模型 |
| 主 Codex 会话/MCP Bridge | 当前项目任务管理与脱敏状态 | 不获得公开的运行时启用、凭据导入或人工审批工具 |
| Task Service | 数据库、管理 token、授权、调度与受控交付 | 不把这些数据直接提供给任务工具 |
| Codex App Server 进程 | 独立模型认证、会话存储、模型网络连接 | 不把认证信息暴露给模型上下文或执行工具 |
| Worker 模型及其工具 | 本任务范围和受限执行环境 | 服务 token、其他任务内容、人工审批权限 |
| GitLab Delivery | 人工批准后的受控 GitLab 写入 | 不向 Worker 下发 GitLab token |

App Server 本身是本机可信宿主程序，其模型网络连接与认证访问不同于“模型要求执行的 shell 命令”。需要被限制的是模型能够驱动的所有工具，而不仅是 shell。

主会话及同用户的任意宿主程序不属于本机安全模型能够对抗的恶意主体。TTY、0700、0600、Cookie 和指纹都不能把恶意宿主程序变成可信操作员。

### 3.2 能力矩阵

| 能力 | 第一阶段 `restricted_local` | 后续扩展 |
| --- | --- | --- |
| 模型调用与结构化报告 | 必须通过真实验证 | 不适用 |
| 本任务文件读取、修改、离线检查 | 必须通过实际权限验证 | 可增加经过审核的工具链 |
| 多任务并发与依赖推进 | 必须通过真实 DAG 验收 | 跨项目调度另行设计 |
| 权限请求拒绝、取消、过期与失联处理 | 必须通过 | 不适用 |
| 自由文本澄清回答 | 必须支持独立回答流程 | 不得混作权限批准 |
| 沙箱外命令、任意文件扩权 | 关闭 | 逐类型验收后单独启用 |
| 工具侧网络 | 关闭 | 仅有界目标、协议与期限，单独验收 |
| 不可信/恶意项目代码 | 不支持 | 受限 OS 账号或容器执行后端 |
| GitLab push/MR | 与 Worker 解锁无关，仍默认关闭 | 既有发布预览和人工批准流程 |

首版不要求“任意权限都能批准”。它要求**权限请求有可靠回路，未开放的权限可靠拒绝**。这样不会为了尚未实现的高权限能力而封死普通任务。

### 3.3 `restricted_local` 的不可降低条件

- 必须实际验证控制凭据、Worker 认证文件和其他任务文件对模型工具不可访问。
- 必须限制当前任务之外的文件修改，不允许修改主 checkout 或共享 Git 元数据。
- 必须确认所有已开放的工具入口，而非只验证 `cat` 或 shell。
- 必须能停止模型 turn、关闭自有进程组，并对不能确认的清理保留隔离状态。
- 必须明确可信代码约束；一旦无法满足该约束，不能通过勾选“我了解风险”放行恶意代码。

如果命名权限配置无法在当前 Codex 版本实现上述基础边界，实施结论必须是 `unsupported_backend`，转用独立 clone 加受限执行后端，不能以弱化验收维持“已解锁”表象。

## 4. 总体架构

```text
Codex 当前会话
   │ 项目绑定、任务计划、上下文、只读环境状态
   ▼
MCP Bridge ────────────────────┐
                              ▼
人工控制台/可信 CLI ──────── Task Service
   │ 检查、验证、启用、停用      │
   │ 人工审批与澄清回答          ├─ RuntimeController
   │                            │    ├─ 状态与版本
   │                            │    ├─ 环境诊断
   │                            │    ├─ 验收证据
   │                            │    └─ 人工启用授权
   │                            ├─ Scheduler / Engine
   │                            │    └─ DAG、预算、资源、任务授权
   │                            └─ CodexExecutor
   │                                 └─ 绑定 execution permit
   │                                      ▼
   │                                 WorkerRuntime
   │                                      ▼
   │                                 Codex App Server
   │                                      ▼
   └─────────────────────────────── 受限任务工具
```

### 4.1 模块职责

| 模块 | 拟承担职责 |
| --- | --- |
| `executor-codex/src/acceptance.ts` | 纯函数评估能力要求与证据，不做登录或 I/O |
| `executor-codex/src/runtime.ts` | 封装真实 App Server 生命周期，供生产执行器和有界验证器复用 |
| `executor-codex/src/probe.ts` | 无模型、无授权副作用的环境诊断 |
| `executor-codex/src/verification.ts` | 固定测试场景、证据采集、预算与清理 |
| `executor-codex/src/approvals.ts` | 固定版本的请求/响应解码、审批类型及期限 |
| `executor-codex/src/profile.ts` | 配置指纹、认证策略、工具权限和环境白名单 |
| `service/src/runtime.ts` | RuntimeController、CAS、启用/失效、执行 permit 与审计 |
| `service/src/daemon.ts` | 接入动态门禁，维持既有调度与 stop 优先级 |
| `service/src/panel-actions.ts` | 可信网页管理接口，不向公开 MCP 开放管理能力 |
| `apps/panel/src/runtime.tsx` | 环境状态、检查和验收过程、人工启用确认 |

不把所有逻辑继续堆进 daemon，也不在前端判断“是否已通过真实验收”。

## 5. 数据模型与证据

### 5.1 存储方案

沿用 SQLite `entity`、`metadata`、`audit`、`idempotency`，本次无需仅为新增 JSON 记录修改 `PRAGMA user_version=2`。

新增实体类型：

| kind | 主键 | 内容 |
| --- | --- | --- |
| `runtime_state` | repositoryId | 单例状态、策略版本、当前诊断/验证/启用引用、fence |
| `runtime_inspection` | inspectionId | 脱敏的环境检查快照 |
| `runtime_verification` | verificationId | 有界验证过程、逐项结果、原始证据索引 |
| `runtime_enablement` | enablementId | 人工启用、到期、撤回或失效记录 |
| `runtime_approval_delivery` | approvalId | 向 App Server 回复审批的投递状态 |
| `runtime_input_request` | requestId | Worker 的澄清问题、回答及投递状态 |

原始证据保存到私有 `state/runtime/evidence/<runId>/`。不在仓库、插件缓存或可被 Worker 工具访问的目录中落盘。

### 5.2 RuntimeState

```ts
type RuntimeMode = 'restricted_local'

interface RuntimeState {
  repositoryId: string
  revision: number
  fence: number
  mode: RuntimeMode
  policyVersion: number
  inspectionId?: string
  inspectionFailure?: { reasonCode: string; at: string }
  verificationId?: string
  enablementId?: string
  verificationRunId?: string
  quarantine?: {
    reasonCode: string
    since: string
    assignmentIds: string[]
  }
  updatedAt: string
}
```

- `revision` 用于管理操作 CAS；实质状态变化递增。
- `fence` 用于失效旧执行许可，启用、停用、策略改变或安全状态改变时递增。
- 同指纹的周期检查成功不反复递增 revision，避免用户确认窗口永远过期。
- `inspectionId` 等指向历史，不覆盖旧记录的证据。
- 调度读取内存中最近已提交快照；SQLite 是持久化事实来源。

### 5.3 RuntimeInspection

```ts
interface RuntimeInspection {
  id: string
  repositoryId: string
  checkedAt: string
  validUntil: string
  fingerprint: string
  executable: { realpath: string; version: string; sha256: string }
  platform: { os: string; release: string; arch: string }
  runtimeBuildHash: string
  protocolSchemaHash: string
  profileHash: string
  policyHash: string
  model: string
  provider: { id: string; endpointOrigin?: string; authMode: string }
  auth: {
    status: 'configured' | 'missing' | 'expired' | 'unsupported' | 'unknown'
    generation: number
  }
  checks: RuntimeCheck[]
}

interface RuntimeCheck {
  key: string
  status: 'passed' | 'failed' | 'unknown' | 'not_applicable'
  reasonCode?: string
  nextAction?: string
}
```

实现时使用严格 Zod schema，拒绝未知字段和超长字符串。路径和 provider 元数据输出前脱敏；endpoint 不包含 userinfo、查询参数或密钥。

`configured` 只说明该认证模式所需配置存在，**不说明模型可访问、余额足够或能完成一次调用**。

### 5.4 RuntimeVerification

```ts
interface RuntimeVerification {
  id: string
  repositoryId: string
  revision: number
  fingerprint: string
  suiteVersion: string
  mode: RuntimeMode
  state: 'prepared' | 'running' | 'passed' | 'failed'
    | 'inconclusive' | 'cancelled' | 'cleanup_uncertain'
  startedAt?: string
  finishedAt?: string
  validUntil?: string
  limits: {
    deadlineSeconds: number
    maxModelTurns: number
    maxModelInputTokens: number
    maxModelOutputTokens: number
    maxConcurrentWorkers: number
  }
  capabilities: Record<string, {
    status: 'passed' | 'failed' | 'inconclusive' | 'not_run'
    evidenceIds: string[]
  }>
  evidence: Array<{
    id: string
    relativePath: string
    sha256: string
    source: 'harness' | 'app_server' | 'os_observation' | 'human_review'
  }>
}
```

要求：

1. 结果绑定真实版本、构建、配置、策略、模型、provider、认证代次及平台指纹。
2. 未执行、未收到期望事件、环境中断均不是通过。
3. 不以 Worker 自述的“测试通过”替代宿主验证器的文件、协议、进程和数据库观察。
4. 验证结果不可原地编辑为通过；重新运行形成新记录。
5. 证据哈希用于完整性和绑定，不宣称能抵抗恶意宿主管理员篡改。
6. 认证轮换、模型或 provider 切换使相关证据失效。
7. 验证默认有效期 30 天；每次版本、配置或实现变化仍立即失效，不能靠未到期继续使用旧证据。
8. 不对原始认证文件、token 或完整环境变量求哈希后公开；认证使用本地代次及脱敏标识。

### 5.5 RuntimeEnablement

```ts
interface RuntimeEnablement {
  id: string
  repositoryId: string
  mode: RuntimeMode
  fingerprint: string
  verificationId: string
  daemonEpoch: string
  status: 'active' | 'disabled' | 'expired' | 'invalidated'
  capabilities: string[]
  operatorId: string
  reason: string
  createdAt: string
  expiresAt: string
}
```

- 默认最长 24 小时；不能晚于所引用验证证据的有效期。
- 首版仅对当前 daemon 实例有效，服务重启后需重新检查并人工启用。
- 不等于 task/plan 执行授权，不批准任何已有或未来权限请求。
- 不解除任务 humanHold，不增加计划预算，不解除服务 dispatch pause。
- 不赋予 GitLab 发布能力。

### 5.6 指纹与失效规则

指纹使用版本化规范 JSON 编码，固定字段排序，再求 SHA-256，避免对象插入顺序影响结果。

必须纳入：Codex 可执行文件实际路径及内容摘要、协议 schema 摘要、执行适配器构建摘要、OS/架构、profile/权限策略、model/provider、auth generation、repositoryId、mode。

| 变化 | 诊断 | 验证证据 | 人工启用 |
| --- | --- | --- | --- |
| 同配置的诊断过期 | 重新检查 | 可继续有效 | 暂停新派发，检查成功后按原有效授权恢复 |
| Codex/适配器/协议/权限变化 | 失效 | 失效 | 失效 |
| 模型/provider/认证代次变化 | 失效 | 模型和相关套件失效 | 失效 |
| 新任务与新普通工作目录 | 启动前检查目录边界 | 通用证据保留，任务夹具检查必须通过 | 不需因此重新授权环境 |
| 服务重启 | 重新检查 | 指纹匹配且未过期可保留 | 失效 |
| 清理不确定或检测到越权 | 不健康 | 相关能力不再可用 | 隔离并失效 |
| 计划或任务范围改变 | 环境不必变化 | 环境证据保留 | 任务/计划授权按原规则失效 |

普通任务文件内容变化不纳入环境指纹，否则每次编辑都会锁死执行；但新增可执行配置、路径重定向、Git 元数据变化必须由任务启动检查处理。

## 6. 状态机与动态门禁

### 6.1 展示状态

```text
disabled ──检查──> checking
checking ──缺认证──> auth_required
checking ──环境可用、无有效证据──> verification_required
verification_required ──人工授权验证──> verifying
verifying ──全部必需能力通过、清理完成──> ready
ready ──人工启用──> enabled
enabled ──检查过期/暂时不可用──> degraded
degraded ──同指纹重新检查成功且启用未过期──> enabled
enabled ──人工停用/授权到期/服务重启──> disabled
任意状态 ──越权/清理不确定──> quarantined
quarantined ──人工核对并重新验证──> ready
```

这些是由检查、验证、启用意图和 quarantine 派生的展示值，不用单个 enum 覆盖全部事实。例如“人工已停用，同时账号缺失”必须能同时保留。

`ready` 表示可申请启用，`enabled` 才表示环境允许生产派发；两者都不代表某个任务已被批准。

### 6.2 基础执行的必要能力

```text
restricted_local.required = {
  protocol_handshake,
  effective_profile,
  tool_filesystem_boundary,
  tool_network_boundary,
  protected_control_data,
  authenticated_model_turn,
  local_edit_and_check,
  approval_decline_round_trip,
  user_input_round_trip,
  cancellation_supported_scope,
  crash_reconciliation,
  real_multi_task_dag
}
```

`runtime_escalation_approval`、`tool_network_grant` 不在首版必要集合里；它们缺失时只关闭相关能力，不关闭已经验收的受限执行。

### 6.3 评估逻辑

```text
evaluateRuntime(snapshot, now):
  如果存在 quarantine => 禁止新启动
  如果当前环境检查缺失、过期或有必要项 unknown/failed => 禁止新启动
  如果必需能力没有有效且匹配的真实证据 => 禁止新启动
  如果人工启用不存在、过期、撤回或 daemonEpoch 不匹配 => 禁止新启动
  否则返回可用能力集合、fence 与 fingerprint

evaluateTask(ticket):
  先执行已有任务授权、依赖、预算、停止锁与资源判断
  若其结果不是 ready => 保留原阻塞原因
  若运行环境不可用 => waiting_runtime，附带具体 reasonCode
  否则 => ready
```

避免环境警告掩盖“前置未验收”“人工停止”“资源被占用”等更直接的任务原因。

### 6.4 刷新机制

- 启动时检查；默认每 60 秒刷新轻量诊断，同一项目 single-flight。
- 人工 `runtime check` 可立即刷新，不调用模型。
- 每次派发前快速检查 binary/profile/策略指纹及最新诊断期限。
- 认证失败、协议断连、策略不符通过事件触发失效，不等待下一次轮询。
- 检查不能在每个 100ms 调度 tick 中 spawn 新 App Server。
- 重检查需要更新数据库和健康视图，不允许只刷新前端文案。

### 6.5 原子 claim 与启动竞态

1. 调度器仅筛选环境和任务均可运行的 launch effect。
2. `Engine.claim()` 在事务中重新检查任务状态、资源和 runtime fence。
3. assignment 保存 `runtimeFingerprint`、`runtimeFence`、`enablementId`。
4. 生成仅供执行器使用、绑定 assignment 的短期 `ExecutionPermit`。
5. Executor 在创建工作目录、进程及发送 `turn/start` 前分别复核 permit。
6. 异步启动期间收到 stop、disable 或配置失效，不得继续投递输入。
7. 如果确定尚未发送 `turn/start`，安全取消该次预启动，清理后保留输入与待执行机会，不计作模型尝试。
8. 一旦 `turn/start` 已发送但结果未知，标为 reconciliation，不自动回到 pending。

为区分已有 generation 与实际模型尝试，新增启动阶段记录：`claimed -> preparing -> process_started -> turn_sending -> turn_acknowledged -> cleanup -> ended`。计划现有分配预算保持不扩大；因环境竞态取消的同一 assignment 不创建新 generation。

`ExecutionPermit` 不是公开 MCP 可传入的数据，也不是一个可由任意调用方设置的 `verified=true`。

### 6.6 失效时对运行中任务的处理

| 事件 | 新启动 | 已在运行的任务 |
| --- | --- | --- |
| 检查 TTL 过期 | 暂停 | 若无边界异常可完成本轮，不继续新一轮 |
| 人工 drain 停用 | 暂停 | 完成本轮后结束，不自动唤醒 |
| 人工 stop 停用 | 暂停 | 使用现有停止流程；只对当时未持有停止锁的任务加组停止归属 |
| 模型限额/认证过期 | 暂停相应 profile | 保存失败/阻塞原因，不做盲目重试 |
| profile/权限改变 | 暂停并失效授权 | 请求停止；不能确认的执行进入 quarantine |
| 越权迹象或进程清理不确定 | 暂停同 profile 的全部新启动 | 隔离相关任务并保留资源；不以“已经发出 kill”当作已清理 |

`runtime disable` 不删除任务、输入、验收结果、工作目录和历史。重新启用也不自动解除既有人工停止。

## 7. 认证与 provider 配置

### 7.1 两种认证必须分开

| 认证 | 用途 | 存放/获取方式 |
| --- | --- | --- |
| panel 登录令牌 | 人工打开本项目控制台 | `STATE/panel-login.token`，不发给模型 |
| Worker 模型认证 | App Server 调用模型 provider | 独立 CODEX_HOME 或经过审核的独立凭据来源 |

解决网页登录问题不会自动登录 Worker；登录 Worker 不会自动启用执行。

### 7.2 首版支持方式

1. OpenAI/ChatGPT：操作员在可信终端针对该项目 Worker 的 CODEX_HOME 登录。
2. 自定义 provider：必须显式配置 provider id、允许的 endpoint、模型、认证方式；不能只设置模型名称就假定沿用主会话代理。
3. 首版自定义 provider 仅开放能够确定隔离的显式凭据配置；不支持的 OAuth/helper 模式返回 `AUTH_MODE_UNSUPPORTED`，不能静默退回主账号。
4. `account/read` 的 account 为 null 不可一概视为失败；须按 provider 契约判断是否需要 OpenAI 认证。
5. 无认证本地 provider 也必须经过真实模型 turn，不能因为“不需要登录”跳过功能验收。

### 7.3 凭据存储策略

- 独立 CODEX_HOME 并不自动证明 OS keyring 已隔离。
- 首版优先使用明确的项目独立凭据存储；文件存储必须在私有 worker-home、0600，任务工具禁止访问该目录。
- 若组织策略强制 keyring，必须实现并验证独立 keyring 身份；做不到则显示不支持，不能覆盖组织要求。
- 环境变量型 provider 凭据只传给可信 App Server，必须验证其工具子进程不会继承。
- `workerEnvironment()` 的 PATH 需规范化，排除可被当前任务写入的目录；不从登录 shell 导入整个环境。
- 原始凭据不进数据库、审计、HTML、URL、诊断结果或 Worker prompt。
- 更新 provider/auth 策略必须形成新的 profile hash，不允许手改配置后继续沿用旧证据。

### 7.4 用户操作示例

以下使用的是现有 Codex 登录命令，不是自动登录脚本；只能由用户在可信终端执行。路径应取该项目返回的 state，不在产品中写死。

```sh
STATE='<当前项目的 state 绝对路径>'
CODEX_HOME="$STATE/worker-home/.codex" codex login --device-auth
```

设备码方式是否可用取决于账号与组织策略；也可使用被允许的浏览器登录或 API 认证方式。密钥不得写入命令参数、聊天或 shell 历史。

登录后运行脱敏诊断，再进行有界真实模型验收。不能把 `login status` 成功等价为模型权限、配额或 provider 连接均正常。

## 8. 文件、网络与工作目录隔离

### 8.1 允许与禁止区域

| 区域 | Worker 工具侧权限 |
| --- | --- |
| 当前任务的普通工作文件 | 读取、修改 |
| 当前任务的专属临时目录 | 读取、修改 |
| 固定系统运行库、已审核工具链 | 最小必要只读 |
| 当前任务 Git 元数据 | 首版默认不可写；只读范围按实际需要最小化 |
| 主 checkout、其他 worktree | 不允许读取或修改，除非显式输入的已验收产物副本 |
| Task Service state、SQLite、socket、tokens | 不允许读取、修改或连接 |
| Worker home、认证、其他 thread 历史 | 不允许模型工具读取或修改 |
| 其他用户 home 内容、SSH、keychain、GitLab 凭据 | 不允许访问 |
| 任意公网/内网/回环网络 | 工具侧默认禁止 |

App Server 的认证与模型网络访问单独处理，不能误把模型工具网络开关当成 provider 网络开关。

### 8.2 worktree 与共享 `.git`

现有 worktree 的 `.git` 文件指向主仓库元数据，不能仅依赖“不让 Worker commit”的提示词。

实施顺序：

1. 对当前 worktree 结构施加实际只读/禁止规则，验证普通文件修改与必要 Git 只读检查能工作。
2. 验证不能通过 `git config`、引用更新、hooks、alternates、符号链接访问或修改主仓库/其他任务。
3. 如果当前沙箱无法满足，改为任务独立 clone；不能使用共享 writable common dir、外部 alternates 或 `--shared` 绕过隔离。
4. clone 的凭据和远端写权限不得进入 Worker；交付适配器在可信侧读取任务 diff，继续按原发布审批处理。
5. 不将生产执行切换到更弱权限，只为让 Git 命令“能跑”。

Git worktree 继续使用还是改 clone，由实际隔离测试决定，必须记录在验证证据的 backend 字段中。此选择变化使旧证据失效。

### 8.3 路径优先级与临时文件

当前 profile 对 state 和用户 home 设 deny，而工作目录可能也在 home 下。必须验证“子目录允许”和“父目录禁止”的真实解析优先级，不凭配置文本推断。

任务 TMPDIR 应为本任务的专属目录，不再把模型工具的临时文件统一放在受保护的 `state/worker-home/tmp`。App Server 自身临时目录与任务工具临时目录需要区分。

对实际 `cwd`、realpath、工作目录归属、符号链接、`.codex`、`.agents` 与 Git 元数据在每次启动前校验。对包含执行配置的仓库给出阻塞原因，不能静默删除用户文件。

### 8.4 验证方式

- 使用假 token 和随机 canary，不在模型测试中尝试读取真实凭据。
- 验证文件读取、编辑、搜索、apply_patch、shell 以及当前版本实际暴露的其他入口。
- 负向用例必须确认“操作实际执行且被边界拒绝”，模型口头拒绝不构成证据。
- 验证子进程继承权限、符号链接绕过、临时目录、Unix socket 与回环连接。
- 检查支持的本地执行入口，如 Codex sandbox 命令时，必须证明它与 App Server 工具采用同一有效策略；不能以另一份配置的成功替代真实 Worker 验收。
- 不使用 `danger-full-access`、跳过沙箱或自动批准来运行生产任务。

依赖安装、包管理器生命周期脚本和网络下载不属于默认离线检查。缺少依赖时应 blocked，由用户在可信侧审核和准备环境，或以后启用单独验收的有界网络能力。

## 9. 运行时审批与澄清回答

### 9.1 分离三类人工决定

1. 环境启用：允许本项目使用哪些已经验收的 Worker 能力。
2. 任务/计划授权：允许执行哪一组任务、范围、期限与预算。
3. 运行时请求：当前 turn 的具体权限或澄清问题。

不能用前两类授权自动批准第三类，也不能用“回答一个问题”授予文件或网络访问。

### 9.2 首版请求处理表

| App Server 请求 | 首版处理 | UI |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | 默认只允许拒绝/取消，禁止自动升级至沙箱外 | 显示命令、cwd、原因、有效期与拒绝说明 |
| `item/fileChange/requestApproval` | 工作区外修改拒绝；工作区内意外请求阻塞并诊断 | 显示文件列表和可获取的变更预览 |
| `item/permissions/requestApproval` | 只返回空授权；不能以 accept 放开全部请求权限 | 展示请求的路径/网络目标及未开放原因 |
| `item/tool/requestUserInput` | 独立保存问题、收集人工回答、按 schema 回复 | 提供逐题输入，不显示“批准权限”按钮 |
| 未支持的方法 | 结构化拒绝，记录脱敏原因 | 明确显示不支持，不静默挂起 |

具体 response payload 以固定版本生成的协议为准，不凭最新网页示例手写所有分支。

### 9.3 审批绑定与一次性投递

每条请求必须绑定：repositoryId、ticketId、assignmentId、App Server epoch、threadId、turnId、itemId、RPC requestId、环境指纹、创建与到期时间。

- 迟到、旧 turn、旧 assignment、停止中的请求不能生效。
- 请求可能早于 `turn/start` 响应到达；先有界缓存，收到 turn id 后验证，超时则拒绝。
- `serverRequest/resolved` 按当前连接和 requestId 处理，不要求通知一定带 threadId；生成协议需确认具体字段。
- 回复前再次验证连接、任务停止锁、scope revision 和请求是否仍 pending。
- 状态流转：`pending -> sending -> sent/resolved`；断连时可能为 `uncertain`。
- JSON-RPC 回复没有被确认时，不在新连接上重发旧请求；原批准不能复用于新 turn。
- 状态写入和 socket 发送不能伪装成单一数据库事务；必须显式保存投递阶段。
- 请求过期、断连、turn 结束和 stop 后使相关预览失效。

### 9.4 后续可批准能力

需要单独设计和验收后，才允许在已有执行后端边界内批准受限权限子集。不能认为 command `accept` 一定仍在沙箱中；先确定该版本该请求是否意味着脱离限制。

后续若支持：

- 权限只限请求子集，不能新增未请求的路径/目标。
- 默认仅当前 turn，不支持 `acceptForSession` 或永久 execpolicy 规则。
- 请求、预览、能力集合和批准均绑定同一 fingerprint。
- 若批准会让进程读取控制凭据或逃离执行后端，直接拒绝，不提供风险确认绕过。

### 9.5 固定版本协议补齐

现有 vendored protocol 只覆盖部分 thread/turn 类型。新增生成并纳入版本清单：账号状态、审批请求/响应、澄清问题、请求 resolved、错误和必要运行通知。

使用已固定的 Codex 二进制生成，不手改自动生成文件。默认 `experimentalApi=false`；如果某项必需权限语义只能通过实验字段实现，则必须明确 opt-in、更新协议指纹并重新验收，不能混用官网最新字段和旧版 schema。

## 10. 停止、清理与重启恢复

### 10.1 正常停止

```text
人工 stop 或安全失效
  -> 任务设置 stopping，禁止新 turn
  -> 使 pending 运行时请求失效
  -> turn/interrupt，最长等待 5 秒
  -> 关闭 App Server，TERM/KILL 自有进程组
  -> 核对实际清理结果
  -> 成功：assignment ended，task stopped
  -> 不确定：reconciliation + runtime quarantine，资源继续保留
```

报告只有在清理完成、assignment 匹配、任务未被停止/改范围时才能写入当前结果；迟到报告只能被拒绝，不能解锁依赖。

### 10.2 首版清理声明

POSIX 进程组清理不是完整的恶意后代回收保证。首版必须：

- 记录进程启动身份、epoch、创建时间与归属，不能仅凭旧 PID 杀进程。
- 测试组长先退出、子进程忽略 TERM、多个 stop 并发、清理超时。
- 用受控夹具测试逃离进程组的后代；检测到该情况后不得报告 `descendantsVerified=true`。
- 对无法证明已经清理的实例保持隔离，人工核对前不释放资源、不派发替代 Worker。
- 产品明确限制为可信代码，禁止主动 daemonize；不把提示词当成恶意代码防线。

如果要支持任意不可信任务，必须换用能约束完整进程生命周期的执行后端，例如按任务隔离的容器。该后端通过自己的清理验收前不能复用本地模式证据。

### 10.3 服务崩溃与恢复

1. 服务重启后先撤销上一个 daemonEpoch 的环境启用。
2. 当前已有 recover 逻辑继续把 running/uncertain 工作转入待核对。
3. 不自动重新发送 `turn/start`、输入、审批回复、commit、push 或 MR 请求。
4. 保存旧 assignment 的环境指纹、thread/turn、输入发送阶段、进程与工作树证据。
5. 可信管理端核对线程、进程与工作目录；旧 PID 已复用时拒绝盲目 kill。
6. 人工选择输入 settled/pending，并保留停止锁；新执行仍需新的环境启用和原有任务恢复授权。
7. 不确定任务的资源不随 lease 到期释放；其他无冲突任务是否继续，取决于 quarantine 范围。

若无法确认是否有未清理 Worker 读取共享 profile，首版隔离整个项目运行环境，而不是只隔离一个节点。

## 11. 真实验证器与首次启用流程

### 11.1 为什么需要独立验证入口

门禁要求真实模型证据，而生产执行器没有证据就拒绝启动，存在验收自举问题。

解决方式不是公开 `bypassGate`：

- 抽出生产和验证共用的 WorkerRuntime。
- 生产调用方必须持有 ExecutionPermit。
- 验证调用方必须持有短期 VerificationPermit，只能运行服务生成的临时夹具和固定测试清单。
- 验证器不接受任意任务范围、任意 shell、任意工作目录或“把生产任务当测试”的输入。
- 验证器与生产任务都使用相同的权限、协议解码、输入发送、取消和清理实现。
- 验证期间暂停本项目生产派发，并确认不存在运行或未核对任务；保留它们的原有授权和队列。

这些 permit 是可信服务内部的权限对象，不声称能抵御已控制服务进程的攻击者。

### 11.2 验证前预览

人工先看到：

- 当前项目、provider、模型和数据将发送的目的地。
- 临时仓库位置、固定场景、权限范围及不会访问真实凭据的说明。
- 最大模型 turn 数、并发、token 预算和最长时长。
- 是否需要两个并发 Worker，以及验收过程中需要人处理的步骤。
- 完成后将保留的脱敏证据与清理计划。

建议首版默认预算：最长 20 分钟、最多 8 个模型 turn、最多 2 个并发 Worker、输入 token 总上限 120000、输出 token 总上限 16000。

token 上限必须由当前版本可验证的 API/usage 或保守预留机制执行。不能控制总输入预算时，先减少场景和轮次或不开放该预算模式；不能仅靠提示词要求模型“节省 token”。价格未知时显示未知，不承诺精确金额上限。

每次 turn 开始前按固定最大上下文保守预留预算，验证器不自动追加额度或自动重试失败场景。

### 11.3 验证分组

| 分组 | 核心验证 | 通过标准 |
| --- | --- | --- |
| V1 协议与环境 | initialize、配置与模型、无控制插件/MCP | 固定版本真实回读与预期一致 |
| V2 权限边界 | canary 读写、工具网络、socket、其他任务、Git 元数据 | 实际操作被允许/拒绝与策略一致 |
| V3 模型编码 | 修改临时文件、运行指定检查、结构化报告 | 宿主独立核对 diff、退出码、输出及 schema |
| V4 请求回路 | 权限拒绝、过期、取消、断连与澄清回答 | 事件与回复准确绑定，不得挂起或越权 |
| V5 取消 | 正常 turn、中途工具、TERM-resistant 子进程、清理异常 | 可确认时停止；不可确认时严格隔离 |
| V6 崩溃恢复 | turn/input 发送阶段中断服务、再启动 | 无隐式重投，资源与审计保留 |
| V7 真实多任务 | 两个根任务并行、人工验收、集成、调整 | 只有有效验收解锁依赖，整体交付可验收 |

某些事件可能取决于模型是否实际发出请求。如果未产生所需事件，结果是 inconclusive，不是通过；确定性协议夹具可覆盖解析分支，但不能冒充真实事件证据。

### 11.4 临时多任务场景

```text
A：修改一个纯函数 + 本地单测 ──artifact 验收──┐
                                             ├─ C：读取验收产物，集成检查
B：补充一份约定文档 ────────artifact 验收───┘
```

- A/B 必须真实重叠执行，不以“顺序执行得很快”冒充并行。
- A/B 的阶段报告不能直接解锁 C；操作员必须在验证界面分别确认产物验收。
- 验证器不得用程序自动代替人接受任务结果。
- C 收到的是绑定版本的已验收产物，不是扫描另一个任务的目录。
- 附加用例验证同一互斥资源不并发、失败仅阻塞后代、调整后授权失效。
- 代码型依赖的本地状态机测试继续保留；真实 GitLab push/MR/merge 需要另行授权，不属于基础 Worker 解锁的必需外部副作用。

### 11.5 完成与清理

- 验证通过后先保持 `ready`，不得自动启用生产执行。
- 操作员核对逐项证据，再单独启用。
- 验证失败保存失败项和下一步，不修改旧任务状态。
- 验证取消或超时必须走与生产相同的清理，不能只删除临时目录。
- 清理未确认保留临时目录和状态，进入 quarantine，不能开始下一次验证覆盖现场。
- 不自动清理用户手动放入的未知路径，不删除真实工作目录。

## 12. CLI、HTTP 与 MCP 接口

### 12.1 接口权限原则

公开 MCP 继续管理任务并读取脱敏 health；**不新增可启用执行、运行模型验收、登录、批准或写入认证的公开 MCP 工具**。

网页所有管理写请求继续要求：回环监听、正确 Host/Origin、有效 session、CSRF、严格 schema、完整目标确认、expectedRevision、requestId。

### 12.2 拟新增可信操作

| CLI | 管理 IPC | 网页入口 | 是否调用模型 |
| --- | --- | --- | --- |
| `runtime status` | `runtime-status` | `GET /api/runtime` | 否 |
| `runtime check` | `runtime-check` | `POST /api/runtime/check` | 否 |
| `runtime verify-preview` | `runtime-verify-preview` | `POST /api/runtime/verification/preview` | 否 |
| `runtime verify` | `runtime-verify` | `POST /api/runtime/verification/start` | 是，必须人工确认预算 |
| `runtime verification RUN_ID` | `runtime-verification-get` | `GET /api/runtime/verification/:id` | 否 |
| `runtime cancel-verification RUN_ID` | `runtime-verification-cancel` | `POST /api/runtime/verification/:id/cancel` | 不新发起调用 |
| `runtime enable-preview` | `runtime-enable-preview` | `POST /api/runtime/enable/preview` | 否 |
| `runtime enable` | `runtime-enable` | `POST /api/runtime/enable` | 不直接调用，但允许已授权队列随后执行 |
| `runtime disable` | `runtime-disable` | `POST /api/runtime/disable` | 不新发起调用 |
| `runtime disable-preview` | `runtime-disable-preview` | `POST /api/runtime/disable/preview` | 否；确认 stop 影响范围 |
| `runtime reconcile` | `runtime-reconcile` | `POST /api/runtime/reconcile` | 否；须先核对任务及已观察进程，不复用旧证据 |
| `answer REQUEST_ID` | `runtime-answer` | `POST /api/runtime/input/:id/answer` | 继续既有 turn，不授予权限 |

离线可信 CLI 另提供 `runtime migrate` 和 `runtime configure-profile`，二者都要求交互确认、私有备份及无活跃 daemon/不确定执行；不通过 MCP 或网页导入凭据。

已有 `worker-check` 保留为诊断兼容命令，但输出明确 `diagnosticOnly=true`，不隐式开启验证或生产执行。

### 12.3 启用请求示例

```json
{
  "requestId": "operation-unique-id",
  "expectedRevision": 7,
  "reviewId": "single-use-preview-id",
  "repositoryId": "current-project-id",
  "mode": "restricted_local",
  "verificationId": "completed-verification-id",
  "expectedFingerprint": "sha256-of-reviewed-environment",
  "reason": "已核对临时仓库真实执行及隔离证据",
  "confirmation": "current-project-id"
}
```

- reviewId 绑定实际预览快照，五分钟内有效，只能消费一次。
- 同一 requestId 重放返回原操作，不重复启用；相同 requestId 不同内容拒绝。
- 预览变化、环境变化、验证过期、版本冲突都必须拒绝，不自动替换 fingerprint。
- 启用返回 `enablementId`、到期时间、有效能力和 operationId，不返回任何凭据。

### 12.4 停用请求

```json
{
  "requestId": "another-operation-id",
  "expectedRevision": 8,
  "repositoryId": "current-project-id",
  "mode": "drain",
  "reason": "暂停后台执行",
  "confirmation": "current-project-id"
}
```

`mode` 仅为 `drain` 或 `stop`。`stop` 的影响任务列表必须在确认前展示；不得清除原有独立 humanHold。

### 12.5 健康与任务响应

health 保留现有字段，但统一含义：

```json
{
  "executionEnabled": false,
  "runtime": {
    "mode": "restricted_local",
    "phase": "auth_required",
    "revision": 3,
    "fence": 2,
    "canDispatch": false,
    "fingerprint": "current-redacted-fingerprint",
    "checks": [
      { "key": "version", "status": "passed" },
      { "key": "auth", "status": "failed", "reasonCode": "AUTH_REQUIRED" }
    ],
    "capabilities": {
      "restrictedExecution": false,
      "runtimeEscalation": false,
      "toolNetworkGrant": false
    }
  }
}
```

- `executionEnabled` 等于当前环境 `canDispatch`，不再只返回静态源码验收值。
- `runtimeReadiness` 作为兼容视图，来自同一评估结果，不能两套逻辑互相矛盾。
- task scheduling 使用 `waiting_runtime` 并增加 `reasonCodes`；前端不解析英文字符串推断状态。
- 容量与资源阻塞继续由现有调度器判断，环境启用不意味着所有节点立即执行。

### 12.6 错误码

| 错误码 | 含义 | 是否自动重试 |
| --- | --- | --- |
| `AUTH_REQUIRED` / `AUTH_EXPIRED` | 认证缺失或已失效 | 否 |
| `AUTH_MODE_UNSUPPORTED` | provider 认证契约不支持 | 否 |
| `MODEL_ACCESS_DENIED` | 模型不可用或无权限 | 否 |
| `RUNTIME_UNSUPPORTED` | 版本、平台或后端不支持 | 否 |
| `RUNTIME_INSPECTION_STALE` | 无足够新的环境诊断 | 仅允许重新诊断，不重投任务 |
| `RUNTIME_VERIFICATION_REQUIRED` | 必需能力没有匹配证据 | 否 |
| `RUNTIME_ENABLEMENT_REQUIRED` | 尚未人工启用或已到期 | 否 |
| `RUNTIME_FINGERPRINT_CHANGED` | 用户核对后环境发生变化 | 否 |
| `RUNTIME_QUARANTINED` | 存在越权或清理不确定 | 否 |
| `APPROVAL_DELIVERY_UNCERTAIN` | 回复是否被接收未知 | 否 |
| `VERIFICATION_BUDGET_EXHAUSTED` | 验证预算不足 | 否 |
| `VERIFICATION_BUDGET_UNSUPPORTED` | 当前后端不能强制执行验证总 token 预算；不得提交模型 turn 或宣称验收通过 | 否 |
| `RUNTIME_RESTART_REQUIRED` | daemon 运行期间构建内容已改变，当前进程不能冒充已加载新实现 | 否；人工停服核对后重启 |
| `REVISION_CONFLICT` | 状态版本发生变化 | 刷新核对，不重放写入 |

## 13. 控制台与登录问题修复

### 13.1 先区分认证错误的类型

当前用户反馈“认证错误”尚未定位到唯一根因，不能直接宣称令牌一定错误。至少要区分：

- 401：令牌不匹配、会话过期或 Cookie 不匹配。
- 403：Host/Origin/Fetch Metadata/CSRF 不符合要求。
- 429：短期内登录尝试过多。
- 网络错误：地址、端口、代理或服务不可达。
- Worker auth_required：模型认证未配置，与网页登录无关。

### 13.2 多项目 Cookie 冲突

当前各端口使用相同 `superagent_panel` Cookie 名称。Cookie 不按端口隔离；同一浏览器打开两个 `127.0.0.1` 项目的面板，后登录页面会覆盖前一个页面的 Cookie。

这是已确认的实现风险，但是否就是用户那次登录失败的原因仍需复现。

修复要求：

1. 每个 panel 实例使用独立随机 Cookie 名称，保留 HttpOnly、SameSite=Strict、Path=/。
2. 后端只查找本实例 Cookie；登录轮换仍使该实例旧 session、CSRF、预览失效。
3. 接受粘贴令牌时仅去除首尾空白，不放宽内容校验。
4. 前端展示不同 HTTP 状态对应的中文原因，不把所有问题都写成“令牌错误”。
5. 登录按钮提交期间禁用，避免双击触发两次 session 轮换。
6. API 返回 session 失效时回到登录态，不继续在已登录页面反复报错。
7. 登录不通过时不在日志、错误提示、调试输出中打印用户输入的 token。

### 13.3 面板实例与令牌文件的一致性

- 同一 state 首版只允许一个活跃 panel 写 `panel-login.token`；启动第二个必须明确复用或拒绝。
- 生命周期记录绑定 state、pid、启动身份、origin 与实例 id，不只靠端口号判断归属。
- `panel-session.json` 只能指向已成功监听且令牌已落盘的实例；写入失败必须关闭新 listener。
- 两个文件不是跨文件原子事务：初始化/替换期间不得宣布就绪，读取端验证 instance id 与发布状态，不能接受旧地址配新令牌。
- 不在用户未确认时重启其他项目来解决一个项目的认证问题。
- 验证面板使用临时令牌；自动化不得读取真实实例 token 代替用户登录。

### 13.4 环境区交互

控制台顶部显示：

```text
Worker：等待认证 / 待验证 / 已就绪未启用 / 已启用 / 已隔离
模式：受限本机执行
模型与 provider：脱敏显示
最近检查：时间、检查是否过期
人工启用：操作者、到期时间
能力：本地编码已开放；沙箱外权限和工具网络未开放
```

主操作按状态展示：诊断、查看登录步骤、预览真实验证、查看验证进度、预览并启用、停止新派发、停止运行中任务。

启用预览必须显示队列中**已获任务授权且可能立即执行的节点**、并发上限及预算。避免用户误认为启用只是改变一个标识、不会启动已有任务。

默认只显示首要阻塞原因和下一步，逐项证据放入展开区。任务页和 DAG 继续显示阶段结论，不用环境详情淹没多任务总览。

## 14. 多任务调度保持不变的约束

1. 环境就绪不等于任务/计划授权，人工仍审批计划指纹、期限和预算。
2. 已批准但因环境等待的 effect 保持 pending，不增加 attempts，不判失败。
3. 没有已验收结果，ready 报告不能解锁下游。
4. 代码依赖继续要求对应已合并 MR 的精确 SHA，并由可信侧核对本地基线。
5. 多个 Worker 必须绑定不同 assignment、thread、工作目录和任务临时目录。
6. 环境层占用和任务层资源锁分开管理；验证器也占用有界运行资源。
7. humanHold、scope adjustment、plan stop/pause 继续按 010/013 执行。
8. 调整任务后旧范围报告标记历史；旧执行未清理前不释放旧资源。
9. 一个节点认证失败或环境异常不会伪造成功结果；同 profile 的新派发根据实际故障范围暂停。
10. 未运行、运行中、待验收、已验收必须区分；不把 Worker 结束当作计划交付完成。

## 15. 配置、迁移与兼容

### 15.1 服务配置

拟把 `service.json` 从 version 2 升级到 version 3，增加：

```json
{
  "version": 3,
  "operatorId": "local-user",
  "concurrency": 1,
  "gitlabEnabled": false,
  "runtime": {
    "mode": "restricted_local",
    "inspectionTtlSeconds": 60,
    "verificationMaxAgeDays": 30,
    "enablementMaxHours": 24
  }
}
```

配置中没有 `verified=true`、`skipAcceptance` 或静态 `enabled=true`；实际启用来自版本化人工授权实体。

model/provider/credentials 策略仍归 WorkerProfile，避免在 service.json 再维护一套模型来源。

### 15.2 迁移步骤

1. 明确选择单个项目，检查服务、运行中任务及不确定操作。
2. 使用 SQLite online backup API 备份数据库；另行备份无凭据的配置。
3. 有运行/停止中/不确定任务时不自动重启、迁移或重写 profile。
4. 由可信迁移命令原子更新 service.json，保存原始 version-2 配置。
5. SQLite 复用既有 schema 2；新增 entity 记录，不改写历史任务和批准记录。
6. 初始 runtime_state 为未启用；旧诊断只作历史，不能升级成验收证据。
7. WorkerProfile 策略变化必须重新计算 hash，旧 binding 不得静默沿用；保留工作目录和旧 thread 供审计，新执行按新授权建立合适的新 thread。
8. daemon 和 panel 重新启动后轮换网页令牌；不读取或展示实际 token。

旧版服务不能读取 version-3 配置时应明确拒绝，而不是忽略未知 runtime 字段继续启动。

### 15.3 插件发布与会话

- Codex 插件仍是 Skill + MCP Bridge；执行门禁不放进 Skill 提示词里。
- 若公开 MCP 只增加 health 字段，可保持工具名兼容；工具 schema 变化需新连接重新发现。
- 开发模式指向本仓库 dist 的已安装插件，不等于每个服务实例自动更新。
- 插件更新必须走正常 manifest/cache 版本与安装流程，不能手改缓存伪装已发布。
- 不把某个本机项目的 state、端口、用户名和 token 路径写进通用插件包。
- 正式分发包需要包含运行时、验证器和必要的版本化验收套件，不依赖开发仓库源码路径。

## 16. 文件级实施清单

| 文件/目录 | 具体改造 |
| --- | --- |
| `packages/executor-codex/src/acceptance.ts` | 删除永久全局锁逻辑，改为能力/指纹/期限纯评估 |
| `packages/executor-codex/src/profile.ts` | 明确 provider/认证存储、工具权限、临时目录、环境变量来源 |
| `packages/executor-codex/src/probe.ts` | provider-aware 诊断、effective policy、脱敏错误与时间 |
| `packages/executor-codex/src/runtime.ts`（新增） | 真实 App Server 通用生命周期、输入投递阶段与中断 |
| `packages/executor-codex/src/verification.ts`（新增） | 固定验证场景、预算、证据、清理 |
| `packages/executor-codex/src/approvals.ts`（新增） | 固定版本请求解析、响应与澄清类型 |
| `packages/executor-codex/src/executor.ts` | 校验生产 permit、去除静态判断、接入运行时与能力 |
| `packages/executor-codex/src/rpc.ts` | 保留单次请求语义，补启动身份及必要可观测性，不自动重放 |
| `packages/executor-codex/protocol/` | 用固定二进制生成并校验新增协议依赖 |
| `packages/core/src/model.ts` | assignment 环境绑定、输入/审批投递相关类型 |
| `packages/core/src/engine.ts` | claim 前环境复核、预启动取消、旧回调拒绝 |
| `packages/core/src/scheduler.ts` | 保留原调度策略，接收动态门禁，不把环境等待当失败 |
| `packages/core/src/ports.ts` | 最小 RuntimeGate/Permit 接口，便于明确测试替身 |
| `packages/service/src/runtime.ts`（新增） | 状态持久化、CAS、fence、可信管理操作 |
| `packages/service/src/config.ts` | version-3 schema、显式迁移、不隐式导入认证 |
| `packages/service/src/daemon.ts` | 控制器接线、single-flight 检查、health 一致性与 stop 优先 |
| `packages/service/src/cli.ts` | 新增可信 runtime 操作与明确费用确认，保留 worker-check |
| `packages/service/src/panel.ts` | Cookie 实例隔离、准确状态码、管理路由与安全约束 |
| `packages/service/src/panel-actions.ts` | 一次性预览、启用确认、澄清回答，不放开任意 runtime accept |
| `packages/service/src/panel-token.ts` | 实例归属、私有文件一致性、第二实例拒绝 |
| `packages/service/src/projects.ts` | 正确项目实例与版本状态，避免错误复用或第二次启动 |
| `packages/storage/src/store.ts` | 复用 entity/事务；仅按实际需要补定向查询，不做无关迁移 |
| `apps/panel/src/runtime.tsx`（新增） | 诊断/验证/启用/停用状态与预览 |
| `apps/panel/src/index.tsx`、`controls.tsx` | 登录错误分类、session 过期处理、接入环境区 |
| `packages/tests/` | 纯状态、HTTP、协议、进程及真实 opt-in 套件 |
| `plugins/superagent/skills/superagent/SKILL.md` | 区分任务授权、环境启用、真实验收；禁止自动审批或导入凭据 |
| `docs/codex-usage.md`、实施状态 | 分开记录已实现、fixture、真实证据和未开放能力 |

## 17. 验收矩阵

### 17.1 不调用模型的自动化回归

| 编号 | 场景 | 必须观察 |
| --- | --- | --- |
| T01 | 无认证/无证据/无启用 | 不 claim、不 spawn、不创建模型尝试 |
| T02 | 只有有效环境启用 | 未批准任务仍不能启动 |
| T03 | 已批准任务等待环境 | effect/input/授权保留，不判 failed |
| T04 | fingerprint 或期限变化 | 旧启用和旧 permit 无效 |
| T05 | 同时 check/enable/disable | CAS、single-flight、fence 正确，无双派发 |
| T06 | claim 后、turn/start 前停用 | 不投递 turn；已发送结果未知则待核对 |
| T07 | 暂停、humanHold、scope adjustment | 环境启用不能解除任务锁或扩大预算 |
| T08 | 权限请求类型与过期/断连 | 严格响应 schema，不越权、不重放 |
| T09 | 澄清问题回答 | 绑定当前 turn，不改变权限 |
| T10 | 请求早于启动响应/resolved 无 threadId | 正确排队和清理，不误挂起 |
| T11 | 两个端口面板同时登录 | 两个 Cookie/session/CSRF 互不覆盖 |
| T12 | 粘贴空白、错误 token、跨源、限流 | 401/403/429 分类正确且不泄密 |
| T13 | 同 state 两个面板启动 | 拒绝/复用，不发生令牌文件覆盖 |
| T14 | 清理失败、旧 PID 复用、迟到报告 | 隔离、资源保留、不 kill 无关进程 |
| T15 | 新旧配置与回滚 | 不隐式启用、不丢历史、不误读旧 schema |
| T16 | 打包与 MCP | 包含所需验证器，无凭据、私有状态和公开管理工具 |

### 17.2 显式 opt-in 的真实验收

| 编号 | 场景 | 合格标准 |
| --- | --- | --- |
| R01 | 当前 provider 真实最小 turn | 访问模型成功，输出有效 schema，不泄露认证 |
| R02 | 临时文件编辑与离线测试 | 宿主核对具体 diff、测试退出码和输出 |
| R03 | 控制凭据/其他任务 canary | 每种工具实际访问被拒绝 |
| R04 | `.git`、符号链接、socket、回环与网络 | 无修改共享元数据，无越界访问 |
| R05 | 真实权限请求与人工拒绝 | 请求/回复/结束事件有完整对应证据 |
| R06 | 真实澄清及回答 | 回答投递到当前请求，旧请求无法复用 |
| R07 | 中途 interrupt 与真实进程清理 | 观察清理结果，异常时正确隔离 |
| R08 | turn/input 发送期间服务崩溃 | 重启后不重放，人工核对后才恢复 |
| R09 | 两根并行、人工验收后集成 | DAG 真实运行、结果快照准确、可整体验收 |
| R10 | 运行中调整与资源锁 | 新范围需重新授权，旧任务清理前资源不释放 |

真实测试必须单独命令启动、先展示预算并人工确认；普通 `npm test`、构建、插件安装和打开项目不能隐式触发模型费用。

测试结果使用 passed/failed/inconclusive/not_run 四态。skip 或无账号不能被计入“全部真实验收通过”。

## 18. 实施阶段与退出条件

### P0：修复管理入口与冻结契约

- 修复多面板 Cookie、错误分类、session 过期、实例与令牌对应。
- 明确 provider/认证方式，固定协议与权限 backend，补生成类型。
- 完成本文接口和 schema 的严格测试。
- 退出条件：两个项目面板可以同时可靠登录；无模型调用；生产门禁保持关闭。

### P1：动态门禁与安全迁移

- 实现 RuntimeController、检查、指纹、证据模型、人工启用实体、fence。
- 接入 scheduler/claim/executor，不提供绕过入口。
- 迁移后默认禁用；只有 fixture 测试不能得到生产通过证据。
- 退出条件：T01–T07、T15 通过，生产仍不因新代码自动开放。

### P2：真实运行时与受限权限边界

- 抽出共用运行时，补 provider 认证、任务 TMPDIR 和文件/网络边界。
- 完成验证器预览、预算、临时夹具、证据采集及审批拒绝/澄清流程。
- 首先完成 V1–V4，隔离失败时解决 backend，不降低测试要求。
- 退出条件：R01–R06 有真实证据，未开放权限仍被拒绝。

### P3：取消、恢复与多任务验证

- 完成进程清理、quarantine、崩溃恢复场景。
- 在临时仓库跑两个真实 Worker 和集成节点，验证调整、预算和资源。
- 退出条件：R07–R10 通过，不能以 fake executor 替代。

### P4：人工启用与发布

- 操作员查看实际项目指纹和验证证据，再启用 `restricted_local`。
- 从低并发、小范围计划开始；逐步开放配置并重新检查。
- 生产启用依旧不打开工具网络、沙箱外批准和 GitLab 发布。
- 完成构建、自动测试、打包、插件安装/新连接检查及使用文档。
- 退出条件：完整多任务执行与监督闭环可用，证据与限制清楚可查。

后续高权限扩展单独立项，不借 P4 把所有未验收功能一起置为通过。

## 19. Git 追踪、回滚与文档维护

### 19.1 Git 追踪约定

仓库已有大量前序未提交改动，不能用一次全量提交把本次解锁和历史改动混在一起。

建议经用户授权后按阶段独立提交：

1. `docs: specify worker runtime unlock contract`
2. `fix: isolate project dashboard authentication`
3. `feat: add runtime readiness and enablement state`
4. `feat: add restricted worker verification harness`
5. `fix: bind worker approvals and recovery to execution`
6. `test: verify real multi-task worker lifecycle`
7. `docs: publish verified runtime setup and limitations`

实施前记录基线 SHA、现有 diff 和文件归属；使用定向暂存并核对 staged diff。没有用户明确授权时不创建分支、不自动 commit、不 push。

token、auth.json、数据库、原始 thread、运行日志和本机证据目录不提交。真实验证摘要可以提交，但必须脱敏，并包含实现版本和证据编号，而不是账号信息。

### 19.2 回滚

1. 先停止新派发；运行中 Worker 按 drain/stop 处理。
2. 清理不确定时不能先回滚文件再假定 Worker 已停。
3. 备份数据库及 v3 配置，不直接覆盖活动 SQLite/WAL。
4. 恢复匹配版本的代码与配置；旧版不理解 runtime 实体时仍不得重新执行历史 effect。
5. 回滚后默认关闭 Worker，保留任务、工作目录、审计与核对状态。
6. 重新启用必须重新核对运行时和有效证据。

### 19.3 实施状态记录

每阶段更新 `codex-implementation-status.md`，分别列明：代码完成项、普通测试、真实执行证据、尚未支持的能力。

实施期间即使已接入动态门禁，也不得因文档新增、协议预检或普通测试通过而修改产品为“执行已验收”。当前固定协议的总 token 预算限制及未运行的真实套件见 015。

## 20. 完成定义

只有以下条件同时成立，才可以向用户报告“受限 Worker 已解锁”：

- [ ] 没有通过静态常量或强制开关跳过真实验收。
- [ ] 当前项目认证/provider/模型可用，指纹和证据匹配。
- [ ] 必需权限边界经过真实工具负向验证，而不只是配置回读。
- [ ] 普通编辑、检查、报告、澄清、停止和恢复闭环通过。
- [ ] 两个真实 Worker 并行，人工验收后集成节点运行并可整体验收。
- [ ] 任务/计划授权与环境启用相互独立，停止锁及预算没有被绕过。
- [ ] 控制台多项目登录稳定，错误提示能区分网页认证和模型认证。
- [ ] 首版未开放权限明确显示关闭，不能被批准按钮或 MCP 放行。
- [ ] 用户人工确认启用了当前项目，其他项目没有被一并开放。
- [ ] 运行、暂停、调整、隔离、回滚的文档与实际实现一致。

## 21. 官方协议参考与版本约束

2026-11-17 查阅的官方 OpenAI 文档：

- [Codex App Server](https://developers.openai.com/codex/app-server/)：初始化、thread/turn、审批、澄清、认证与中断。
- [Codex Sandboxing](https://developers.openai.com/codex/sandboxing)：权限、工具执行边界及平台实现。
- [Codex Authentication](https://developers.openai.com/codex/auth)：CODEX_HOME、凭据存储、登录及自定义 provider。

官方文档可能领先本机固定的 `codex-cli 0.154.0-alpha.6.2`。接口细节最终以该二进制生成 schema、实际协议响应和验证证据为准；文档示例本身不是当前实现已通过的证明。
