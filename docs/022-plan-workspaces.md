# 按计划绑定基线与受控工作区

后续权限调整：2026-11-21 按 [023](023-trusted-worker-git.md) 开放本仓库 Git 元数据写权限，信任 Worker 在任务分支本地暂存、提交，操作边界由提示词约束。本文 worktree 的服务托管、固定基线、迁移和依赖规则仍然有效。

## 修改目标

1. CMDB 的 `insight-v1` 与启明天镜的 `main` 能在同一已登记仓库内独立运行，不再依赖全局 `HEAD` 快照。
2. 以结构化计划字段记录 repositoryId、完整 baseRef、固定 baseSha、目标分支、工作分支前缀及绑定标识；这些字段进入审批指纹。
3. 服务在模型启动前执行受控 worktree 创建/核验；协调 Agent 可通过受控接口重试准备，Worker 直接使用已准备的目录，不必自行写共享 `.git`。
4. 旧基线迁移必须预览并由人确认。保留原分支、工作区、未提交修改、执行历史；新绑定使用新目录和新分支，旧授权失效。
5. 工作区准备失败不启动模型、不领取执行轮次，显示结构化阻塞；不能通过反复重试 Worker 消耗预算。

## 权限与范围

- 原设计不开放共享 Git 元数据写入；该项已由 023 的可信本地提交模式替代。不开放任意文件系统路径、工具网络或跨仓库访问，fetch/push 仍由可信操作者及交付流程处理。
- 当前一个项目服务对应一个已登记仓库。计划显式绑定该 repositoryId；其他仓库必须在其自身项目服务建立计划，错误绑定直接拒绝。
- 默认解析本地 `refs/heads/*` 或 `refs/remotes/origin/*`；记录解析时间，不声称远端已同步。远端刷新仍须由可信操作者明确完成，再预览并固定新的 SHA。
- 当前固定 Codex 协议没有动态工具声明字段。本次不伪造 Worker 原生工具；受控接口由协调器调用，并由执行器在派发前自动调用。

## 数据与接口

- `Plan.workspace` 保存不可变的结构化绑定；新计划可携带明确的基线 SHA，也可后续在控制台配置。
- `plan_workspace_preview`：读取指定分支的本地 SHA、受影响成员版本和旧工作区信息，返回限时预览。
- 管理员 `plan-workspace-configure`：确认预览、核对成员/计划版本与活动状态、核对分支未移动，原子归档旧绑定并切换到新绑定；不立即创建工作区、不自动执行计划。
- `task_workspace_prepare`：仅在当前计划已授权、任务可调度且尚未运行时，准备该任务唯一的受管目录。没有参数可以扩大范围。
- 新工作区位于已登记 executionRoot 下，分支包含绑定标识与任务 ID；创建前检查名称、路径、Git 配置、已有目录归属、基线和依赖。
- 派发前同样调用此受控准备流程；失败写入 `workspace_blocker`，保持 assignment 为 pending。成功后再次核对版本、授权和停止状态，才允许 claim。

## 迁移与交付

- 已有运行/停止清理/待核对操作、未清理子 Agent、已接受结果或已绑定 MR 的计划禁止直接迁移。
- 空闲但排队的任务可以在迁移事务中取消未领取的派发；整个计划重新要求人工授权。独立人工停止不解除。
- 旧工作区、旧输入处理状态及结论归档；Worker 下次使用新线程，并重新处理未退回/未被替代的输入。错误要求不会因聊天文字而自动修改绑定。
- 发布预览与 MR 目标分支遵循计划绑定，不错误使用项目全局 HEAD；代码依赖仍需已合并且在固定基线中，缺失时阻塞而非自动合并。
- 本次不修改真实计划、审批、工作区或运行服务；上线需安全重启后在控制台配置相应计划并确认。

## 验收矩阵

- 同仓库两个计划独立固定不同分支/SHA；工作区与发布目标正确且互不污染。
- 旧工作区有修改仍原样保留；迁移后旧授权/线程不可复用；版本竞态、请求重放安全。
- 已有目录/分支冲突、符号链接、不同仓库、错误 SHA、移动的引用、活动执行、代码依赖缺失均拒绝。
- 准备失败不会启动 Worker，不增加领取次数；修复后受控准备能清除阻塞。
- 控制台鉴权/CSRF/确认、MCP 权限边界、构建及完整回归测试通过。

## 实现约定与具体流程

### 字段和目录

`Plan.workspace` 与成员 `Ticket.workspaceBinding` 包含相同的 `id / repositoryId / baseRef / baseSha / targetBranch / branchPrefix / resolvedAt`。绑定 ID 由服务生成；用户不能提交任意工作目录。字段进入计划授权指纹，后续任务/计划变更仍沿用已有 CAS 和人工授权规则。

- 新计划输入 `workspace: { repositoryId, baseRef, baseSha, branchPrefix }`。服务首先核验登记仓库、完整引用和本地 commit；已成功请求的同 ID 重放读取原回执，不因引用随后前进而重复创建。
- 新目录为 `executionRoot/<ticketId>-<bindingId>`，新分支为 `<branchPrefix>/<bindingId>/<ticketId>`；旧计划未配置时保留原命名。
- 基线只在创建/确认迁移时解析，确认后引用前进不会漂移 SHA。再次授权只核验 pinned commit 仍可用、成员绑定一致，不自动跟随引用。

### 服务接口

| 入口 | 参数 | 权限及结果 |
| --- | --- | --- |
| `plan_workspace_preview` | `planId, expectedRevision, repositoryId, baseRef, branchPrefix` | 协调器可请求；返回五分钟预览 ID、固定 SHA、成员版本与旧目录 |
| `plan-workspace-review` | `planId, previewId` | 管理员 CLI 重新读取待确认的持久化预览 |
| `plan-workspace-configure` | `planId, expectedRevision, previewId, requestId, confirmation` | 仅管理通道；完整计划 ID 确认，原子归档/切换/撤权；相同请求幂等 |
| `task_workspace_prepare` | `ticketId, expectedRevision` | 仅已授权、依赖就绪且 pending 的任务；返回 `ready`、工作区或结构化错误 |

HTTP 控制台以会话、Origin、CSRF 保护 `/api/plans/:id/workspace/{preview,configure}` 和 `/api/tasks/:id/workspace/prepare`，URL ID 必须等于请求体 ID。CLI 配置需要 TTY，展示服务端预览而不是仅展示不透明 UUID。MCP 只增加预览与准备，不提供迁移管理权限。涉及工作区的 IPC 等待上限为 120 秒；超时后先查询任务/计划实际状态，配置重放必须复用请求 ID。

### 安全迁移事务

1. 核对预览有效期、确认文本、计划及所有成员版本；核对本地引用仍指向预览的 SHA。
2. 拒绝活动 Worker、派发中/准备中任务、running assignment、待核对/停止清理、未完成非 launch effect、未清理子 Agent、已有验收结果/MR及已完成计划。
3. 保存 `workspace_archive`（旧完整计划、成员、输入状态、报告、工作区和线程）；原目录、分支及文件不作任何删除或重置。
4. 取消未领取 launch、结束 pending assignment但保留历史；赋新绑定、清除当前 workspace/branch/baseSha/thread/report/failure，未退回/未替代输入重新 pending。置 `restartThread`，撤销执行授权，清除旧工作区 blocker，过期未决审批。
5. 计划 version/revision 递增、旧 grant 删除；持久化审计和幂等回执。不清零历史分配预算，不解除独立人工 hold，不启动模型。

### 派发前准备

在 `engine.claim` 之前，服务确认授权、停止状态、资源和依赖，再读取已验收代码依赖用于基线祖先检查。调度中的准备占用并发槽位及资源，避免异步准备阶段超额派发；每任务进行中的准备请求合并，配置迁移拒绝该任务。完成后再次核对任务 revision、计划与依赖快照，发生变更不回写授权/工作区、不复活删除记录。

准备失败落盘 `workspace:blocker:<ticketId>`，调度显示 `waiting_workspace`，不循环尝试、不创建模型进程、assignment 不转 running、effect attempts 不增加。目录创建和归属已验证但 `.codex` 等运行配置检查失败时，保存已验证的工作区绑定供人工修复，重查不会覆盖或丢弃修改。若异步期间发生停止/版本变化，已创建目录保留，但不把过期结果附回任务。

Worker payload 明确传入受管 cwd、分支、固定 SHA 和计划绑定，旧任务文字中的“自行创建 worktree”不能覆盖这些执行约束。发布预览、MR 观察和代码验收均使用绑定目标。固定基线不包含后续已接受代码依赖时仍会阻塞；当前版本不支持迁移已有验收结果的计划，应保留原验收链并另建后续计划，不能宣称支持自动集成这些提交。

### 部署边界

构建只是更新本地源码产物，不会热升级已启动 daemon。先安全停止/核对执行，再重启对应项目服务；重新安装插件或建立新 MCP 连接以发现新增工具。此实现不自动操作现有两个业务计划、不改其引用、不批准任务、不重新安装或重启业务服务。

## 2026-11-21 实施与验证

- 已实现计划/成员结构化绑定、审批指纹、服务级预览/配置/准备、工作区归属及依赖验证、派发前 blocker、迁移归档/新线程、GitLab 目标贯通、MCP/CLI/控制台和 Skill 指引。
- 迁移不清零历史预算；已用尽额度的任务在重新确认计划后保持可人工追加一轮的空闲状态，不生成无法解锁的超额 pending 队列。
- 完整 TypeScript/面板生产构建通过；`npm --prefix packages test` **258/258 通过，0 失败、0 skip**（较原 233 项增加 25 项）。新增验证包括两基线、发布目标、dirty workspace 保留、回滚、过期/CAS/幂等、引用移动、活动/已验收/MR 拒绝、子 Agent 清理、代码依赖、异步停止/删除、准备槽位与资源预留、HTTP/CSRF/桥接权限和真实 daemon 的 claim 前阻塞恢复。
- Chromium 桌面/移动端交互冒烟通过：旧计划警告、完整引用预览、旧目录展示、确认按钮门槛、配置后刷新；页面错误为 0。浏览器所有接口均为本地模拟路由；另有真实临时服务 HTTP 接口测试，不冒充生产操作或真实模型验收。
- React 静态渲染、Skill 校验、CLI 帮助入口与 `git diff --check` 通过。测试限于临时仓库/测试 provider；没有发送真实付费模型请求、push 或创建 MR。
- 未重新安装插件、未重启业务项目服务、未迁移/批准现有业务计划；未提交 Git，保留已有未提交修改。
