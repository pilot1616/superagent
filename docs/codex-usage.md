# Codex 本地任务服务使用说明

## 推荐流程：一次目标确认

详见 [020 · 中央协调工作流](020-centralized-workflow.md)。让主 Agent 打开当前项目并建立任务图；创建计划时可填写 `workflow: { automaticHandoffs: true, materialPaths: ["/absolute/reference.pdf"] }`，把业务决策节点标为 `reviewRequired: true`。只填写你明确提供的文件，不自动扫描目录。

在控制台的计划页确认一次范围、依赖、预算、资料路径和人工里程碑。服务自动检查环境、启用受限运行时、创建只读快照并分发给成员；不需要另行解锁或逐任务附加。普通 artifact 节点在结构化报告和状态检查通过后自动交接；最终结果、人工里程碑、代码合并和外部发布仍保留人工边界。

控制台的启动/恢复/重试确认是直接人工决定，无需再去审批中心申请一次。超预算重试仅追加一轮，不扩大基础自动预算。主 Agent 的公开 MCP 仍只能申请额外授权，不能代你批准。普通重启在重新检查通过且原授权未过期、指纹未变、无未知执行时复用授权。

旧计划没有 `workflow` 时继续原有人工交接和独立运行时授权；不因升级自动获得资料权限。下方逐任务资料命令及运行时控制保留为高级/旧流程入口，不是新计划的必走步骤。

## Worker 技能、工具链与只读资料

Worker 不复制主会话的 HOME、插件、MCP、完整聊天记录或权限。按 [018 设计](018-worker-development-capabilities.md) 显式补齐开发能力，控制数据和其他任务仍隔离。

**人工追加重试**：`maxAttempts` 仍是含首轮的基础分配额度。控制台选择“追加一轮并重试”并确认即可，无需二次审批；只授权唯一下一轮，不改计划上限，也不授权后续轮次。MCP 发起的超预算请求仍等待人确认。版本、到期时间、依赖、暂停、人工停止和未知执行检查继续生效。019 的预算模型保留，交互由 020 简化。

**配置技能与工具链**：先停止并对账项目内执行，再关闭该项目服务。在可信终端执行；技能目录可多选，工具链只读根应只含程序和运行库，不要填写 HOME、仓库、其他 worktree 或凭据目录。

```sh
node packages/dist/service/src/cli.js runtime configure-capabilities --state /absolute/project-state --json '{"skills":["/absolute/path/to/pdf-parser"],"toolchain":{"pathEntries":["/opt/homebrew/bin"],"readRoots":["/opt/homebrew/Cellar"],"environment":{}}}'
```

命令交互确认 `configure-capabilities`，复制所选技能为带哈希的只读快照，并保留模型、provider、认证文件和子 Agent 设置。每次配置是完整替换能力配置；未列出的旧技能不保留。macOS 自动检测开发工具目录和真实 Git；可通过 `DEVELOPER_DIR`、`SDKROOT` 等白名单环境项显式覆盖。不会安装 `pdftotext`、Python 库等依赖。重启后由新计划的目标确认合并重新检查与启用；旧计划也可使用环境诊断入口。普通诊断不调用模型，新增 `toolchain_git` 检查在命名沙箱内执行。

**提供 PDF 等任务资料**：新计划优先在 `workflow.materialPaths` 声明，随目标确认自动分发。旧任务或额外补充可在任务详情展开“只读参考资料”，填写绝对路径、预览并确认附加。只开放快照而非桌面源目录，源文件后续修改不自动同步。

运行中或待派发任务先停止；附加不启动任务、不验收结果、不清除旧失败或 hold。附加后按原计划授权和预算显式恢复/重试。CLI 等价入口：

```sh
node packages/dist/service/src/cli.js materials preview --state /absolute/project-state --json '{"ticketId":"TASK_UUID","expectedRevision":1,"paths":["/absolute/reference.pdf"]}'
node packages/dist/service/src/cli.js materials attach --state /absolute/project-state --json '{"ticketId":"TASK_UUID","expectedRevision":1,"previewId":"PREVIEW_UUID","requestId":"UNIQUE_REQUEST_ID"}'
node packages/dist/service/src/cli.js materials list --state /absolute/project-state --json '{"ticketId":"TASK_UUID"}'
```

附加命令需可信终端交互确认，公共 MCP 不提供这些权限。资料与技能快照必须存储在系统临时目录之外。任务 Git common directory 开放写权限，信任 Worker 在分配的分支直接 `git add` / `git commit`，普通本地提交不另加审批。提示词要求只暂存任务文件、使用已配置身份、报告实际提交 SHA，不操作其他任务分支、不破坏历史、不修改共享配置；这些 Git 范围约束不是强隔离。fetch、push、切换分支和发布不由 Worker 自行执行，远端发布仍走服务审批。资料保持只读，工具网络仍关闭。详见 [023 设计](023-trusted-worker-git.md)。

## 已批准但没有启动

计划授权、计划暂停和 Worker 环境启用是独立状态。计划批准不会解除暂停；需要在“计划控制、授权与预算”中确认“恢复新派发”，不必重复申请计划授权。

如果首个节点显示“等待运行环境”，检查 Worker 环境的具体原因。`PROCESS_OBSERVATION_FAILED` 表示本机进程身份检查失败或超时，不表示 Codex 版本一定不支持。macOS 使用只读 `libproc` 原生观察器，通过 `proc_listallpids` 和逐 PID 的 `proc_pidinfo` 读取 PID、父 PID、进程组和启动时间，不再依赖可能卡住的 `/bin/ps -axo pid=,ppid=,pgid=,lstart=` 或全量 `sysctl(KERN_PROC_ALL)`；Linux 继续使用 `ps`。其他用户的受保护进程保留可读的父 PID 和进程组，启动时间标记为不可验证；如果 Worker 或已观察后代出现这种情况，则阻止执行与清理确认，而不是忽略该进程。两种平台均使用异步、合并中的采样和独立的 3 秒截止时间，避免同步扫描阻塞控制台与调度；超时后终止观察器，未确认其退出前不重复创建，仍然阻止执行，不能跳过进程归属和后代清理检查。

macOS 构建需要 Xcode Command Line Tools 提供的 `/usr/bin/cc`。在实际运行主机执行 `npm --prefix packages run build`，原生观察器会随构建生成并随运行包分发，其内容纳入运行时指纹。缺少或无法运行该程序时不会退回可能卡住的 `ps`，也不会绕过检查。重新构建改变运行时指纹后，重启项目服务并在目标控制中重新确认运行；相同指纹下的普通重启复用未过期授权，不需要重复启用。

`Worker checkout contains .agents` 是旧版将仓库技能目录整体视为执行配置的误拦截。新版允许只有 `skills` 的真实 `.agents` 目录及指向 checkout 内部的技能链接，不删除主仓库的 `.agents`；`.codex`、未知执行配置、越界/循环链接和特殊文件仍然阻塞。预检失败后已创建的工作区会保留绑定；旧版遗留的未绑定工作区只有在同仓库、同任务分支、同基线且完全干净时才能复用。修复后重试仍受原计划授权和尝试预算约束；`maxAttempts: 1` 的已失败节点不能借重启或重复审批无限重试，需要新的计划授权与预算。

## Worker 内多 Agent

新建 profile 支持一个 Worker 内主 Agent 带多个子 Agent，默认最多 3 个并发子 Agent、仅一层。任务详情可查看分工、状态与未验收结论；停止父任务会统一清理。子 Agent 共用任务 worktree，主 Agent 须划分不重叠的文件写集；需要分支隔离时仍拆成多个任务。详见 [017 设计](017-worker-subagents.md)。

旧 profile 不自动启用。先确认没有运行/停止/不确定任务，停止该项目服务，再由用户在可信终端执行（替换路径、模型和 provider，勿向模型提供凭据）：

```sh
node packages/dist/service/src/cli.js runtime configure-profile --state /path/to/project-state --json '{"model":"YOUR_MODEL","provider":{"id":"openai","authMode":"openai"},"agents":{"enabled":true,"maxConcurrent":3,"maxDepth":1}}'
```

重启该项目服务后，由新计划目标确认完成检查与重新授权；此配置命令本身不启动模型、不授予任务权限。关闭时使用 `agents.enabled=false`。自定义 provider 应保留该项目原来的 provider 配置，不要照抄成 OpenAI。

当前是开发预览；先读 [实施/验收状态](codex-implementation-status.md)。**新计划一次目标确认合并环境准备与任务图授权；完整验收不是启动硬门槛。** 完整真实验收仍未完成，没有强制总 token/费用上限。初始化不会调用模型或推送代码。

当前工作流见 [020](020-centralized-workflow.md)，运行时安全规则沿用 [016](016-worker-verification-advisory.md)。环境区仍提供高级诊断和显式启用，但新计划不需要分别操作；授权通过不等于真实执行验收通过。

插件默认按**当前会话项目**工作，不再固定指向 insight-plugins1。先调用 `superagent_project_open`，传入真实会话的项目绝对路径，再读 health、建计划。宿主提供 MCP roots 时服务会校验；没有 roots 时由主对话明确传入上下文中的项目路径，不能猜测 MCP 进程 cwd。每个会话只绑定一个项目，项目间 state、审批和控制台隔离；同项目不同会话复用实例。首次项目初始化需要 `initialize=true` 及明确模型或事先配置的本机默认模型，不复制认证。详见 [012](012-session-project-binding.md)。

`project_open` 返回该项目的 `state`、`dashboardUrl` 和 `loginTokenFile` 路径。后续终端操作须把 `SUPERAGENT_STATE_DIR` 指向这个 state；网页也应使用返回地址，不能继续打开另一个项目的旧看板。返回的是令牌文件位置，不是令牌值，用户自行在可信终端读取。

主流程现在是关联多任务协调，而不是逐个手动启动独立任务。完整字段与边界见 [010 第 9 节](010-multi-task-orchestration.md#9-确定的实现契约与接口)。数据库 schema 1 首次打开时自动生成 `tasks.sqlite.before-v2.sqlite` 备份并升级为 schema 2；旧任务和审批不会自动归组或授权。

## 多任务操作主流程

### 人工任务驾驶舱

看板默认打开“计划与依赖”：点击 DAG 节点即可查看阶段结论、阻塞原因和任务详情。“任务”页默认只展示未结束任务，每页 10 条，可切换待我处理、已结束或全部并按名称搜索；输入、UUID 和审计默认折叠。“审批中心”每页最多 10 项，预览以范围、图、预算、到期时间和发布 diff 为主。

任务详情支持“追加说明”（下一轮消费，不是即时 steer），以及“暂停并调整范围”（修改名称、范围、优先级、资源和原因）。范围调整会撤回旧授权；计划成员会停止整组并作废旧计划授权，未验收成员的旧报告在列表和时间线中标记为历史。等待停止清理完成后，重新申请任务恢复或计划授权，由人在审批中心核对；清理期间仍锁定旧执行占用的资源。已验收结果不能覆盖且可继续供依赖任务使用，执行后的依赖拓扑不能直接改写。进展、报告与失败记录保留原范围和轮次，重试不会清空历史；它们不是人工验收凭据。已合并但还没有结果验收的代码任务仍保留在待处理视图。

Worker 未就绪时，展开顶部“查看原因与下一步”，可点击“诊断 Worker 连接与认证”。也可用 `node packages/dist/service/src/cli.js worker-check --state <本项目 state>` 在可信终端诊断。检查不会登录、复制认证、发起模型 turn 或开放门禁。已批准任务保留在等待运行环境状态，不会因为门禁关闭而被调度失败。独立认证和真实隔离/审批/取消/恢复验收仍需完成，单元测试通过不能替代它们。细节见 [013](013-task-cockpit.md)。

更新构建后需要重启本项目 daemon 和 panel 才会加载新代码与静态资源；先确认没有运行中、停止中或不确定任务。新 MCP 工具 `task_adjust` 需要新连接重新发现；不要以为旧会话已热更新。面板重新启动会轮换登录令牌，用户自行在可信终端读取，不能交给模型。

1. 先用 `thread list/get`、`task list/get` 查看已有工作。对共享输入用 `thread create/subscribe`、`event record` 持久化；`route context` 查看所有权与相关任务，`task route` 批量选择新建草稿/关联/忽略/停止，逐项查看结果。context 订阅和 correlated 关系不会自行创建任务或赋权。
2. 有前置关系的目标使用 `plan create` 一次创建任务图，指定资源、优先级、整体验收任务和每任务 Assignment 次数上限。返回的 mapping 将短 key 映射到真实 ticketId。
3. `plan start` 只申请授权；由人在本地控制台审批中心预览并输入完整审批 ID 批准，或在可信终端运行 `approvals`、`approve APPROVAL_ID`，检查完整计划与 fingerprint。有效授权且环境就绪后，调度器按依赖和容量连续派发；当前真实环境验收未完成，Worker 保持等待，不会实际改代码。
4. Worker 结果 ready 后不自动解锁下游。人在终端用 `accept-result --json '…'` 接受产物，或接受已合并且本地基线包含的代码。代码先走现有独立发布审批和人工合并；服务不自动合并、拉取或 cherry-pick。
5. `plan get` 查看每个节点为什么等待；`task retry` 只重试指定失败/阻塞任务，计划内使用已批准的剩余次数，不能重试不确定操作。`plan pause` 只暂停新派发，`plan stop` 取消未完成任务；停止清理后重新 `plan start` 请求整组恢复，原先单独停止的任务仍保留 hold。
6. 每个必需节点与 integration 节点都完成验收后，人工 `complete-plan` 或控制台“确认整体交付”接受整体交付。控制台提供计划、依赖、节点阻塞、共享上下文、逐项审批、任务/计划控制和结果验收。安全边界见 [011](011-local-control-panel.md)。

示例仅是命令格式，请替换 REPOSITORY_ID、实际到期时间和 requestId；不要将示例当作已启动的任务：

```sh
node packages/dist/service/src/cli.js plan create --json '{
  "repositoryId":"REPOSITORY_ID",
  "title":"接口与页面协作交付",
  "tasks":[
    {"key":"contract","title":"接口契约","request":"定义并验收接口契约"},
    {"key":"backend","title":"后端","request":"依据契约实现后端","resources":["backend-code"]},
    {"key":"frontend","title":"前端","request":"依据契约实现页面","resources":["frontend-code"]},
    {"key":"integration","title":"集成验收","request":"在包含前后端代码的共同基线上验证"}
  ],
  "dependencies":[
    {"before":"contract","after":"backend","condition":"artifact"},
    {"before":"contract","after":"frontend","condition":"artifact"},
    {"before":"backend","after":"integration","condition":"code"},
    {"before":"frontend","after":"integration","condition":"code"}
  ],
  "integrationKey":"integration",
  "maxAttempts":3,
  "expiresAt":"2026-11-18T12:00:00.000Z",
  "requestId":"replace-with-a-unique-request-id"
}'

node packages/dist/service/src/cli.js plan get --json '{"planId":"PLAN_ID"}'
node packages/dist/service/src/cli.js plan start --json '{"planId":"PLAN_ID","expectedRevision":1,"requestId":"another-unique-request-id"}'
node packages/dist/service/src/cli.js approvals
node packages/dist/service/src/cli.js approve APPROVAL_ID

node packages/dist/service/src/cli.js accept-result --json '{"ticketId":"CONTRACT_TASK_ID","expectedRevision":CURRENT_REVISION,"kind":"artifact","content":"经人工验收的完整接口契约"}'
node packages/dist/service/src/cli.js accept-result --json '{"ticketId":"MERGED_CODE_TASK_ID","expectedRevision":CURRENT_REVISION,"kind":"code","content":"人工检查的 MR 合并与测试证据"}'
node packages/dist/service/src/cli.js complete-plan --json '{"planId":"PLAN_ID","expectedRevision":CURRENT_REVISION}'
```

`CURRENT_REVISION` 是须替换为整数的占位符。首次 `plan_create` 不运行；不要将自动调度误认为绕过真实执行门禁。并行上限由私有 `service.json` 的 concurrency 指定（1–4，默认 1）；人工跟进唤醒最多可额外使用一个保留槽位。更新配置后显式重启服务；不要向公共 MCP 提供私有凭据。

运行中的新增输入先持久排队，下一 Assignment 才消费；真实实时 steer 尚未验收。已验收产物不可变，更改需求需新任务/新计划；不能对已执行图原地增加节点、扩大预算或偷偷替换依赖结果。

## 1. 构建与检查

要求：Node.js >=24.2.0、Git、当前验收平台 macOS/POSIX。App Server 适配器只接受本机已固定版本 `codex-cli 0.154.0-alpha.6.2`，不表示它是最新版本。

在项目根目录运行：

```sh
npm --prefix packages ci --ignore-scripts
npm --prefix packages run check
npm --prefix packages run probe
node packages/dist/service/src/cli.js help
```

原 DSH 检查仍是根目录 `pnpm check`，新包检查是 `npm run check:codex`。两个检查互不替代。

## 2. 显式初始化一个独立实例

以下路径和模型名是占位说明，须替换成用户自己的实际选择。不要登记生产仓库进行首次实验。state、repo、worktrees 不能互相嵌套；state 必须是空的专用目录并使用 realpath/canonical path。

```sh
node packages/dist/service/src/cli.js init \
  --repo /absolute/path/to/test-repository \
  --worktrees /absolute/path/to/separate-worktrees \
  --state /absolute/path/to/private-state \
  --base main \
  --model YOUR_EXPLICIT_MODEL
```

默认 state 是 `~/.local/state/codex-superagent`，可用 `--state` 或 `SUPERAGENT_STATE_DIR` 修改。Unix socket 路径需小于 100 字节；不要把状态放在本项目或插件缓存下。

初始化只登记现有本地仓库，不 clone、不启动 Worker、不登录、不读取/升级旧 `orchestrator.sqlite`。生成的 service.json、tokens、SQLite 和 Worker Profile 在独立 state 下，不能提交到 Git。新 profile 不继承主 Codex MCP、插件和账号凭据。

接受无 origin 的本地仓库，或登记的 GitLab 实例上的 HTTPS/SSH origin；默认 `https://gitlab.com`。支持多级 subgroup 和 SSH 自定义端口；HTTPS 地址必须是不带子路径的 origin，暂不支持 HTTP 实例、反向代理子路径与跨项目/fork MR。不要把访问令牌写入 remote URL。

自建实例可显式指定，例如下面使用 `git.in.chaitin.net`（仅示例，不会自动读取该实例已有账号凭据）：

```sh
node packages/dist/service/src/cli.js init \
  --repo /absolute/path/to/existing-gitlab-repo \
  --worktrees /absolute/path/to/separate-gitlab-worktrees \
  --state /absolute/path/to/new-private-gitlab-state \
  --gitlab-url https://git.in.chaitin.net \
  --base main --model YOUR_EXPLICIT_MODEL
```

**旧实例迁移：** 新配置为 version 3。GitLab version-2 实例在停服且没有运行/停止中/不确定任务后，交互运行 `runtime migrate --state STATE`，使用 SQLite online backup 备份后显式升级；不会启用 Worker。旧 version 1、`githubEnabled` 或 GitHub 仓库/PR 数据仍被拒绝，须使用新的 state/worktree 根初始化 GitLab 实例，不能手改版本号复用历史授权。数据库 schema 仍为 2，与 service.json 版本无关。

## 3. 前台服务与任务操作

```sh
export SUPERAGENT_STATE_DIR=/absolute/path/to/private-state
node packages/dist/service/src/cli.js serve
```

另一个终端：

```sh
node packages/dist/service/src/cli.js status
node packages/dist/service/src/cli.js doctor
```

从 status 读取 `repository.id`，再明确建单：

```sh
node packages/dist/service/src/cli.js task create --json \
  '{"repositoryId":"REGISTERED_ID","title":"明确的任务标题","request":"明确的范围和验收要求","requestId":"UNIQUE_REQUEST_ID"}'
node packages/dist/service/src/cli.js task list --json '{}'
node packages/dist/service/src/cli.js task get --json '{"ticketId":"TICKET_ID"}'
```

requestId 至少 8 个字符，建议 UUID。相同操作和 requestId 的相同 payload 返回原结果；不同 payload 报冲突。超时后不得换新 ID 盲目重做。`task_get` 的 events 最多 50 条，传最后 sequence 作为下一次 cursor。

启动申请与批准分离，revision 从最新 get 获取：

```sh
node packages/dist/service/src/cli.js task start --json \
  '{"ticketId":"TICKET_ID","expectedRevision":1,"requestId":"ANOTHER_UNIQUE_ID"}'
node packages/dist/service/src/cli.js approvals
node packages/dist/service/src/cli.js approve APPROVAL_ID
```

CLI 批准必须在真实交互终端内查看结构化摘要并完整输入该 approval ID；也可在登录后的本地控制台完成等价人工预览和确认。没有 `--yes`、批量自动批准或 MCP 自批准。新计划批准时自动准备受限环境；独立任务和旧计划仍需有效的运行时授权。等待环境时 effect 保持 pending，不消耗尝试预算，不冒充执行失败。

追加输入需要 expectedRevision，不解除 stop。idle 问题答复后需显式 resume；失败/blocked 用 retry。控制停止的示例：

```sh
node packages/dist/service/src/cli.js task stop --json \
  '{"ticketId":"TICKET_ID","expectedRevision":CURRENT_REVISION,"requestId":"UNIQUE_STOP_ID","reason":"人工要求暂停工作"}'
```

`CURRENT_REVISION` 必须替换成 JSON 数字。服务 `pause` 只停止新派发，不中断活动任务；`unpause` 恢复派发。task_stop 则持久化 humanHold，普通消息、CI/评论、重启都不能解除。

## 4. MCP / 插件副本

源码清单采用兼容布局，使用 `superagent-local mcp bridge`。它要求运行时可执行文件已在 PATH 中，不能直接假定 GUI 有相同 PATH。

无需全局安装，先为你选择的**仓库外新目录**生成本地插件副本：

```sh
npm --prefix packages run configure-plugin -- \
  --destination /absolute/path/to/new-local-superagent-plugin \
  --projects-root "$HOME/.local/state/superagent"
```

脚本验证构建后的 CLI 和当前 Node 路径，在副本 `.mcp.json` 写入它们的实际绝对路径；不将开发机路径写回通用源码清单。副本仍依赖当前源码的 dist/node_modules，移动源码后必须重新配置。

此命令不修改 personal marketplace、Codex 配置或启动服务。实际 marketplace 注册/安装须在用户授权后通过 plugin-creator 和 `codex plugin add` 完成，再用 `codex plugin list --json` 和新会话验证。仅生成副本不能称为“已装入 Codex”。用户级插件不绑定默认仓库，每个会话通过 project_open 选择当前项目；若明确需要固定单实例，可将上例 `--projects-root` 换成兼容的 `--state`，不能同时指定。

可先显式配置本机默认模型，避免每个新项目重复选择；目录必须是新的专用宿主目录，既有设置不自动覆盖：

```sh
node packages/dist/service/src/cli.js projects configure \
  --projects-root "$HOME/.local/state/superagent" \
  --json '{"version":1,"defaultModel":"YOUR_EXPLICIT_MODEL"}'
```

已有单实例可在 `projects` 数组中登记 `{repositoryPath,state,dashboardUrl?}`；登记时验证精确仓库和服务健康，不移动数据库，也不将该仓库设为默认值。没有本机默认模型时，首次 project_open 需显式传 model。

MCP 可直接开发调试：

```sh
node packages/dist/service/src/cli.js mcp bridge
```

该进程 stdout 仅用于 MCP 协议，不是交互式 shell；诊断走 stderr。默认会话模式提供 project_open，显式调用它可在初始化获准后连接/启动该项目服务及独立控制台，普通任务工具不会自动启动服务。Bridge 没有 approve、任意 shell、SQL 或文件读取工具；未选择项目时返回 PROJECT_REQUIRED，有残留服务锁时拒绝盲目重启。

## 5. 本地审批控制台

在可信交互终端运行：

```sh
node packages/dist/service/src/cli.js panel --port 0
```

仅监听 `127.0.0.1` 的随机端口。终端打印地址与独立登录令牌，在页面表单输入；不把 token 放 URL，不发给模型。登录会话一小时过期，重新登录会使旧会话与预览失效。

计划页直接展示目标确认、调度控制、依赖和阶段结论。普通启动/恢复/重试采用一次确认按钮，不再抄写目标 UUID 或跳转二次审批；公开 MCP 的授权申请仍在“需要你确认”中展示完整范围。预览最多五分钟、单次使用，变化后须重新预览。发布仍核对 diff、提交作者和完整审批 ID，运行时权限扩张仍禁止批准。健康环境折叠为诊断入口，保留高级检查及 drain/stop 停用。没有任意 shell、凭据读取或自动合并入口。

常驻后台模式显式使用固定私有令牌文件：

```sh
node packages/dist/service/src/cli.js panel --port 43187 \
  --state "$SUPERAGENT_STATE_DIR" \
  --token-file "$SUPERAGENT_STATE_DIR/panel-login.token"
```

日志只显示地址和文件位置。用户自行在可信终端读取该文件并输入页面，禁止模型读取。macOS 可将 daemon 和此命令分别配置为用户 LaunchAgent：登录后启动、异常退出恢复，使用绝对运行时路径。受托管时永久停止应 `launchctl bootout` 对应 job，否则 KeepAlive 会重新拉起；不再只用 `shutdown` 表示停机。退出登录则停止，不是系统服务。

控制台不嵌入 Codex 原生 UI；`panel` 命令本身不自动打开浏览器或注册系统后台服务。连接失败后先查询实际状态，不自动重放写操作。

## 6. 发布：默认关闭，先做隔离仓库验收

只有在人为确认独立 GitLab 测试仓库和最小权限凭据后，才在停服时配置 `service.json` 的 `gitlabEnabled` 并由用户提供 state 下的 `gitlab.token`（0600）。凭据不进入 Worker 环境、manifest、Git argv 或面板。当前未做真实网络交付验收，不建议用于生产。

使用能访问目标项目的 personal/project access token；REST MR 创建需要相应 API 权限，HTTPS push 需要仓库写权限，实际能力还受项目角色和受保护分支限制。当前读取 `PRIVATE-TOKEN`，Git 使用同一 token 进行 HTTPS Basic 认证；不自动读取或复制 `glab` 登录/keyring。不要把 token 放到命令行、聊天或仓库里。受控 push 禁止强推和重定向，MR 不自动合并或删除源分支。

ready 后，先 `inspect TICKET_ID` 获取 head SHA，再用 `task publish` 申请（传 ticketId/expectedRevision/headSha/requestId）。然后：

```sh
node packages/dist/service/src/cli.js publish-preview APPROVAL_ID \
  --author-name 'YOUR_COMMIT_AUTHOR' --author-email 'YOUR_COMMIT_EMAIL'
node packages/dist/service/src/cli.js approve APPROVAL_ID
```

预览将当前 head、完整 tree（含未跟踪文件）、base、分支、作者、标题和说明哈希绑定；批准时重新计算。默认拒绝符号链接、子模块、危险 Git 配置及单文件超过 20MB 的交付。只进行非强推和本任务 MR 创建/更新，不自动 merge、关闭其他 MR 或删除分支。

CLI 会随确认提交刚展示的 `expectedFingerprint`；管理员 IPC 的发布批准也必须提供该字段。另一终端若刷新了同一审批 ID 的预览，旧确认会被拒绝，必须重新查看再确认，不能只重发 ID。

发布记录包含 preflight、commit、push、MR 阶段。前置校验失败且尚未开始交付写入时，旧授权作废，任务不会永久卡在 reconciling：重新运行 `task publish`、`publish-preview`、`approve`。已进入写阶段或旧记录缺少阶段信息时，仍保留不确定态，不自动重发。

仅观察已绑定 MR：分页读取 notes/discussions（含系统消息）和关联 pipelines、当前 head SHA 的项目 pipelines；同一事件去重，状态变化形成反馈。审批系统消息也只是非可信外部输入，不授予 Worker 权限；不调用 approve/merge 接口，暂不承诺精确 approval rules/state 读取。失败退避，连续六次失败停止自动读取，人工 `observe TICKET_ID` 可核查并重置。

无 MR 的本地 ready 结果可由用户运行 `complete TICKET_ID` 明确接受。MR 未合并不冒充完成。

`complete` 要求输入全部结算，且没有待决审批或未结束的操作；发布 pending/running/uncertain 期间不能接受本地完成。处理新增输入或解决进行中的交付后，再重新检查任务。

## 7. 备份、停止、恢复

```sh
node packages/dist/service/src/cli.js backup
node packages/dist/service/src/cli.js shutdown
```

backup 使用 SQLite online backup API，在私有 state/backups 输出数据库快照；不粗暴复制活动 WAL 数据库。备份也含任务文本，按敏感数据管理。还应由用户备份 service.json/profile 配置；凭据单独管理。

异常退出后，`recover-lock` 只有在记录 PID 已不存在时才能删除锁；PID 被复用时拒绝自动处理，不 kill 任意进程。重启后此前 running/uncertain 的工作进入 reconciling，不自动重发 turn/input/push；明确停留在发布 preflight 且无 commit 核对点的记录可安全作废授权，重新预览。

stop 会等待共享清理操作及自有进程组退出，不把主进程退出当作所有进程结束。清理超时或无法确认时保留 stopping/reconciling，不能立即替换 Worker；真实 Codex 后代逃逸与完整取消验收仍未完成，属于风险提示，不作为事前派发门槛。

用户核对线程、进程、工作树和外部交付后，运行：

```sh
node packages/dist/service/src/cli.js reconcile TICKET_ID \
  --note '具体核对过的线程、进程与输入证据' --disposition settled
```

`pending` 表示核对后明确允许这些不确定输入在下一次授权执行中重投，不是“无损恢复”。两种选择都保留停止锁；随后仍须申请 resume。发布核对使用 `reconcile-publish TICKET_ID`：确定未开始写入的 preflight 可作废；其他情况仅在远端唯一 MR 和持久 commit SHA 一致时落库，不进行网络写入。

代码回滚用新增 revert 提交，数据库回滚前先停服、备份并检查 schema。未提供自动恢复旧版本数据的承诺。

## 8. 删除任务与计划

- 独立任务：进入任务详情 → **删除任务** → **预览删除范围** → 输入“删除” → 确认。
- 关联计划：进入计划详情 → **删除整组计划**，核对全部成员后确认。不能单独删除计划成员，以免破坏依赖关系。
- 执行中、排队、停止清理中或待核对的任务不能删除。先停止任务/整组，再等清理结束；删除不绕过运行环境核对。
- 这是持久化逻辑删除：任务/计划从列表与调度中消失，审批过期、订阅解除。SQLite 保留 `deleted_task` / `deleted_plan` 快照、审计和阶段结论；工作区、分支、资料及远端 MR 原样保留。没有一键恢复，也不会释放这些文件的磁盘空间。
- 删除使用版本检查和幂等请求 ID。状态变化后需重新预览；同一请求网络重试不会重复删除。MCP bridge 没有直接删除权限。

可信终端也支持以下命令，必须交互输入完整目标 ID，不支持非交互式确认：

```sh
node packages/dist/service/src/cli.js task delete --state /absolute/project/state \
  --json '{"ticketId":"TASK_ID","expectedRevision":1,"requestId":"UNIQUE_REQUEST_ID"}'

node packages/dist/service/src/cli.js plan delete --state /absolute/project/state \
  --json '{"planId":"PLAN_ID","expectedRevision":1,"requestId":"UNIQUE_REQUEST_ID","tasks":[{"ticketId":"TASK_ID","expectedRevision":1}]}'
```

ID、版本须取实际详情；计划 `tasks` 必须包含全部成员及对应当前版本。删除功能升级后，需要安全重启对应项目服务和控制台才能使用；不要为升级直接终止运行任务。

## 9. 本地分发包

```sh
cd packages
npm pack --pack-destination /absolute/path/to/output-directory
```

prepack 会构建并只打包白名单中的新运行时。运行包依赖官方 MCP SDK/Zod 与面板相关 npm 依赖，不依赖 DSH；不会夹带 SQLite、凭据、测试仓库、旧源码、插件安装缓存或 node_modules。这里不自动 `npm install -g`，不上传 npm/GitLab。

真实模型执行会把任务与必要代码上下文发送到所选模型供应商；本地 SQLite 不代表离线推理。

## 计划工作区与基线（2026-11-21）

计划可独立绑定完整本地引用，例如 `refs/remotes/origin/main` 或 `refs/remotes/origin/insight-v1`。这是**本地已存在引用**，不会自动 fetch，也不代表远端最新。服务负责创建 worktree；不要再要求 Worker 自行执行 `git worktree add`。

- 新计划：`plan_create.workspace` 可指定 `repositoryId`、`baseRef`、`baseSha`、`branchPrefix`；服务核验引用与 SHA，目标确认覆盖这组字段。
- 旧计划：在计划详情展开“计划工作区与基线” → 填完整引用及分支前缀 → 预览 → 输入计划 ID 确认切换 → 重新“确认目标并启动 / 恢复”。活动执行必须先安全停止；已有验收结果或 MR 的计划需保留原交付，另建计划，不原地迁移。
- 原工作区、分支、未提交修改与历史都保留；新绑定生成新目录和分支，下次使用新 Worker 线程。独立停止不会自动解除，历史执行预算不会清零。
- “等待工作区准备”表示模型尚未启动，本轮未领取、effect attempts 未增加。修复明确的本地引用/目录/配置问题后，在任务详情点击“重新检查工作区”，或协调器调用 `task_workspace_prepare`。不要靠反复重试模型解决 Git 准备问题。
- GitLab 发布目标跟随计划绑定，发布仍需独立 diff 确认。固定基线缺少已接受代码依赖时明确阻塞，不自动 merge/cherry-pick；本轮不支持在已有验收结果的计划中改写基线。

可信 CLI：`workspace preview|configure|prepare --json '{...}'`。预览参数为 `{planId, expectedRevision, repositoryId, baseRef, branchPrefix}`；配置参数为 `{planId, expectedRevision, previewId, requestId}`，CLI 会重新展示持久化预览并要求交互式确认；准备参数为 `{ticketId, expectedRevision}`。复用相同请求 ID 查询/重试未知配置响应，不直接改 SQLite。设计与边界见 [022](022-plan-workspaces.md)。

源码构建不等于运行中服务已更新。上线时先检查运行任务并安全停止/对账，再重启对应项目服务；插件工具清单和 Skill 更新需重新安装/建立新 MCP 连接。本轮不自动迁移真实计划或批准执行。
