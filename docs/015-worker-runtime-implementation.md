# Worker 解锁实施记录与剩余门槛

> 2026-11-18 更新：已按用户要求移除插件的完整验收硬门槛，改为非阻塞风险提示；环境检查、人工启用和任务审批仍保留。最新规则见 [016](016-worker-verification-advisory.md)。下文是此前实施记录，未完成的真实验收仍未被宣称通过。

> 依据：[014 Worker 真实执行解锁设计](014-worker-runtime-unlock.md)。
> 状态：部分实施完成，**尚未完成 014 的首版完成定义，真实 Worker 未解锁**。

## 1. 交付边界

本次不是把验收常量改成 `true`，也没有换一个配置开关绕过验收。生产派发改为读取本项目持久化的环境检查、真实证据、人工启用和执行 fence；原有计划、依赖、资源锁、任务授权及停止锁保留。

目前已交付可运行的管理与安全基础设施。真实验证器只完成共用运行时的协议预检，明确在模型调用前停止，记录 `inconclusive / VERIFICATION_BUDGET_UNSUPPORTED`。V2–V7 没有被伪造为通过。

### 1.1 按 014 阶段对应

| 阶段 | 当前状态 | 实际结果与缺口 |
| --- | --- | --- |
| P0 管理入口与契约 | 代码及自动化回归已实现 | 实例 Cookie、令牌/地址发布归属、第二面板拒绝、状态码分类、登录轮换与版本化契约 |
| P1 动态门禁与迁移 | 代码及自动化回归已实现 | 状态实体、指纹、期限、CAS、一次性预览、人工启用、fence、assignment permit；生产没有自动开放 |
| P2 受限运行时与真实验收 | 部分实现，不能宣布完成 | 共用 WorkerRuntime、provider 显式配置、请求解码与澄清、协议预检和证据落盘；所有工具边界、真实编码及请求回路未完成验收，预算后端受阻 |
| P3 取消、恢复和多任务 | 机制与局部回归已补充，真实套件未完成 | POSIX 身份观察、自有组清理、已观察逃逸保留隔离、崩溃不重放；真实 Codex 中断恢复和 A/B/C 多任务验收未运行 |
| P4 人工启用与发布 | 未完成 | 没有当前项目的完整真实证据，没有人工启用生产，没有重新安装/发布插件 |

“未运行”不是通过；普通测试里的合成证据只能证明门禁状态机，不是可复用到用户项目的验收结果。

## 2. 已实现模块

### 2.1 环境事实与指纹

- `executor-codex/src/contracts.ts`：严格、有限长的检查、验证、启用、状态 schema，以及 12 项必需能力。
- `executor-codex/src/acceptance.ts`：纯函数评估检查 TTL、认证、匹配证据、人工启用、daemon epoch 和隔离状态。`executionEnabled`、健康视图和调度 blocker 使用同一事实来源。
- `executor-codex/src/inspection.ts`：固定二进制版本及内容、构建/协议/profile/策略、平台、模型/provider、认证代次和仓库绑定；检查最终配置，而不只看生成的 TOML。
- 同配置的成功刷新不递增管理 revision。构建文件在 daemon 存活期间变化会要求重启，不能把磁盘新构建冒充当前已加载的代码。
- 认证文件的私有 stat 标记仅保存在私有 metadata，用来推进认证代次；不公开认证文件内容或内容哈希。

### 2.2 人工启用和许可

`service/src/runtime.ts` 持久化 `runtime_state`、`runtime_inspection`、`runtime_verification`、`runtime_enablement` 和一次性 review。启用要求精确项目确认、当前 revision、五分钟内未消费的预览、匹配 fingerprint/verification，并核对私有证据文件的 SHA-256。预览同时绑定实际可派发队列、已授权待执行计数、预算和运行中影响范围；新增授权或目标变化会要求重新核对，不能静默扩大已展示的队列。

启用最长 24 小时且不晚于验证有效期；重启撤销前一 daemon 的启用。没有公开 MCP 启用或认证工具，没有 `skipAcceptance`、`verified=true` 或 `--yes`。

claim 保存 `runtimeFingerprint`、`runtimeFence`、`enablementId` 和启动阶段。执行许可是服务内签发并按对象身份登记的短期对象，复制 JSON 字段不能制造许可。创建进程和提交 turn 前分别复核。

在 `turn/start` 未发送时遇到环境撤回，可清理后把同一 assignment 放回 pending，退还这次预启动的 effect attempt，不增加 generation。进入 `turn_sending` 后不做这种回退。

### 2.3 provider 与凭据

- WorkerProfile 升级为 version 2，与 service.json 的 version 3、SQLite schema 2 分开。
- OpenAI 身份显式使用项目独立、私有的文件凭据存储；不导入主会话的账号/keyring。
- 自定义 provider 显式声明模型、HTTPS/回环 endpoint、`env` 或 `none`；拒绝 URL userinfo、查询参数、隐式 OAuth/helper 和静默主账号回退。
- `env` 模式仅从私有 `worker-home/provider-credentials.json` 读取 `{ "secret": "..." }` 传给 App Server；工具环境不继承该变量，真实工具隔离仍须 V2 验收。
- profile 写入使用私有临时文件和 rename，目录必须拥有、私有且 canonical；配置变更只能离线、备份并明确确认。
- 任务 TMPDIR 使用宿主创建的随机专属私有目录，并校验实际路径在工作目录内；进程清理后删除，避免进入交付 diff，清理不确定则保留现场。真实工具侧边界仍须验收。

### 2.4 请求与清理

- 固定二进制重新生成账号、审批、澄清、resolved 和 usage 类型；`protocol/manifest.ts` 记录来源哈希。生成脚本不手改自动生成类型。
- 提前到达的请求有界缓存到 turn 确认后；resolved 通知不强制携带 threadId，但校验连接和请求归属。
- 所有扩权 accept 仍拒绝；permissions 仅返回空授权，不允许 session/permanent 规则。
- 澄清回答走独立 `runtime-answer`，校验问题集合、assignment、epoch、thread、turn、范围、期限和停止状态。问题及回答投递阶段保存在私有实体，审计不记录原始回答。
- 回复显式记录 sending/sent/resolved/uncertain，不将 SQLite 写入和 socket 发送伪装成原子事务，也不向新连接重发旧请求。
- `rpc.ts`/`processes.ts` 观察 PID、父进程、组和启动时间；停止核对自有组，并拒绝把已观察到的存活逃逸后代当作清理成功。
- 观察不是任意恶意 daemon 的完整追踪保证。`descendantsVerified` 不会因为组退出而置为 true；无法确认时保留资源与 quarantine，禁止替代执行。

### 2.5 面板

- 每个实例独立 Cookie 名称，保留 HttpOnly/SameSite=Strict；不同端口不会覆盖会话。
- 实例锁、随机 instanceId、地址、tokenHash 和发布状态一致；token 文件先私有写入，发布失败关闭 listener。
- 同 state 第二面板拒绝，不覆盖令牌；显式 `recover-panel` 只恢复确定已死的所有者，PID 存活或复用均拒绝。
- 登录粘贴只 trim 首尾空白，提交期间禁用；401 回登录态，403/429 与网络错误分开提示。登录轮换撤销旧 CSRF 和预览。
- 环境区显示诊断、认证、证据、启用和隔离状态，以及启用后可能派发的已授权节点、并发和运行中影响范围。阶段结论和 DAG 不被移除。

## 3. 为什么仍不能宣布解锁

### 3.1 可重复核对的协议限制

本机固定版本为 `codex-cli 0.154.0-alpha.6.2`。其生成的 `TurnStartParams` 没有可强制执行的总输入/输出 token 上限。

`model_context_window` 是上下文设置，`thread/tokenUsage/updated` 是事后观察；二者都不能单独强制限制一次工具驱动 turn 内部的多次模型请求总预算。也不能把提示词中的“少用 token”当作配额执行器。

因此，当前验证器不会提交模型 turn。它会留下带 fingerprint 的协议预检证据，其余能力为 `not_run`；没有 validUntil，不会产生可启用的真实通过记录。此限制在预览、结果及 UI 中明确说明，不静默降级成无预算运行。

解除此阻塞需要实现并证明能够强制总请求预算的后端/协议适配，再补齐 V2–V7。仅登录账号不能解决预算、隔离和真实多任务验收缺口。

### 3.2 尚未交付的真实套件

以下工作没有在本次被替换为 fake executor 或自述报告：

1. 所有实际工具入口的 canary 读取/修改、symlink、Unix socket、回环与网络拒绝；worktree 共享 `.git` 的实际边界，必要时改独立 clone/受限后端。
2. 有认证模型修改固定夹具、独立核对测试退出码、结构化报告。
3. 真实权限请求的拒绝/过期/失联，以及真实澄清请求的人工回答。
4. turn/input 发送期间真实 Codex 中断、进程清理、服务崩溃及恢复核对。
5. 两个真实 Worker 重叠执行，人工分别接受 A/B 产物后运行 C；运行中调整、资源锁及整体验收。
6. 用户对实际项目的有效真实证据单独确认启用，然后完成发布包/插件安装及新会话核对。

这些缺口意味着 014 的完成定义仍未达到，不应对外说“严格全部完成”或“已经可以运行真实任务”。

## 4. 当前可用操作

以下 `STATE` 必须取本会话项目的实际 state，不能复用别的项目。命令中的 `superagent-local` 在源码开发时可以替换为 `node packages/dist/service/src/cli.js`。

```sh
superagent-local runtime status --state "$STATE"
superagent-local runtime check --state "$STATE"
superagent-local worker-check --state "$STATE"
```

`runtime` 命令通过已启动的本项目服务获取同一份状态；兼容的 `worker-check` 在服务未运行时也可做离线诊断，但不形成可启用的证据。不登录、不生成真实模型费用、不启用生产。

验证预览需要当前 runtime revision 和 repositoryId：

```sh
superagent-local runtime verify-preview --state "$STATE" \
  --json '{"expectedRevision":1,"repositoryId":"实际项目 ID"}'
```

必须用服务实际返回的值替换示例 revision/ID。`runtime verify` 要求把预览中的 `reviewId`、`expectedFingerprint`、`limits` 和 revision 原样提交，再在真实 TTY 输入项目 ID。当前只会进行协议预检，不会得到完整真实通过结果。

`runtime enable-preview` 在没有完整匹配证据时必须拒绝，不能通过 CLI JSON 声明通过。`runtime disable` 的 drain 只暂停新派发；stop 先用 `runtime disable-preview` 确认运行任务范围，保留独立停止锁。

### 4.1 升级旧 GitLab 实例

1. 用旧版服务先核对并停止本项目任务，处理不确定 effect；不要重启其他项目。
2. 停止旧 daemon。若崩溃残留锁，在可信终端使用 `recover-lock`，它也允许先核对合法 v2 配置；PID 可能复用时拒绝自动处理。
3. 运行 `runtime migrate --state "$STATE"` 并交互确认。备份 SQLite、v2 service.json 和旧 profile；数据库历史不重写、不导入账号。
4. 启动 `serve --state "$STATE" --with-panel`，取得新实例地址，由用户在可信终端读取新的本项目登录令牌。
5. 先诊断，再处理未支持的后端及真实验收；迁移不把旧诊断升级为证据，也不自动启用。

离线改模型/provider 使用 `runtime configure-profile --json '{"model":"明确模型","provider":{"id":"openai","authMode":"openai"}}'`，必须先停服核对，并重新检查/验证。密钥不进入该 JSON、聊天、命令参数或审计。

## 5. 验证与 Git

基线 HEAD：`86768bffa5ec5ae7f086d873387d8493f7a18216`。实施前已有大量用户/前序未提交修改；本次保留，不自动 stage、commit、建分支或 push，不修改真实项目实例、凭据或安装缓存。

验证入口：

```sh
npm --prefix packages run check
git diff --check
```

新增普通回归覆盖：动态门禁、证据完整性、指纹/期限/认证代次/daemon 失效、single-flight/CAS/幂等、预启动撤回、任务授权与 hold 不被解除、请求早到/resolved、澄清单次回答、多面板 Cookie 与 CSRF、面板锁、离线迁移、已观察逃逸后代。

真实 App Server 的协议预检测试使用临时、无认证、本地假 provider，断言 provider 请求为零、`modelTurns=0`、结果为 inconclusive。这不是 R01 的真实模型测试。

打包需包含 `dist/executor-codex/protocol` 的版本化 manifest，不能只打入 src 后让安装包缺失指纹输入。正式发布/全局安装未执行。原始证据、数据库、auth、token 和日志继续留在私有状态，不写入仓库。

最终 `npm --prefix packages run check` **128/128 通过，0 skip**。临时 npm 实际打包及仅生产依赖安装通过，安装后的 CLI、版本化协议诊断与受保护面板/服务做了零模型调用冒烟验证。`git diff --check`、Markdown 链接/围栏和 Skill 校验通过。详情在 [实施状态](codex-implementation-status.md) 的最新章节；历史通过数字保留为历史，不充当本轮或真实验收证据。
