# 全局插件与本地审批控制台

后续用户已明确要求管理当前会话项目；插件绑定方式按 [012](012-session-project-binding.md) 改为会话选择，而非本节原来的全局固定 state。网页审批的身份、预览和确认约束不变。

## 1. 本次变更

用户明确要求全局安装 Codex 插件，并允许从 UI 审批和控制任务。本设计取代 009、010 及旧使用说明中“面板永久只读、审批只能使用 CLI”的限制；其他授权、停止、不可变结果、发布指纹和真实 Worker 验收门禁保持不变。

插件按用户安装到 personal marketplace，MCP bridge 绑定显式实例的 state，使用 Node/CLI 绝对路径，不依赖会话所在目录或 GUI PATH。新会话可调用插件，旧会话需要重新开始。服务独立运行；本机用 macOS LaunchAgent 管理 daemon 和控制台，在用户登录时启动并在异常退出后恢复，不以 Worker 账号运行。插件不能批准自身。

## 2. 浏览器授权边界

- 仅绑定 127.0.0.1；保持 Host、Origin、Fetch Metadata、CSP 和 no-store 校验。
- 使用独立随机登录令牌、HttpOnly/SameSite=Strict Cookie、一小时会话及登录限流。每次重新登录轮换 Cookie、CSRF 和所有待确认预览。
- 所有写接口要求同源 JSON、有效会话及自定义 CSRF 头；限制请求体长度。无任意 RPC、SQL、shell、文件读取、账号导入或凭据展示接口。
- 待审批列表只读。审批前显式请求服务端预览，返回完整审批、任务范围或计划图；发布预览需要作者信息并生成绑定 diff 的 fingerprint。
- 预览生成一次性 reviewId，有效期不超过五分钟和审批到期时间。确认必须输入完整审批 ID，并携带 reviewId。服务重新读取审批，比对完整审批快照，消费预览后才调用既有 decide；失败后必须重新预览，不能盲目重试。
- 计划/发布沿用当前 fingerprint 校验；过期、版本变化、停止锁和权限扩张仍由核心拒绝。runtime 权限扩张只允许拒绝，不因 UI 新增而放开。
- 控制只允许 task start/resume/retry/stop、plan start/pause/stop、结果接受和整体计划接受；参数使用既有严格 schema，要求人工输入目标 ID。新启动只是申请授权。结果接受必须输入证据，代码接受仍验证已合并 MR 和本地基线。
- 成功与失败明确区分，展示 operationId。请求超时或连接失败要求先刷新实际状态；不得自动换 requestId 重放。

## 3. 常驻控制台

保留交互终端打印令牌模式。新增 `panel --token-file STATE/panel-login.token`，仅允许这个固定私有位置，将令牌通过 0600 临时文件原子替换，不跟随符号链接；日志只打印地址和令牌文件路径，不打印令牌。启动器和插件都不读取该文件。用户在自己的可信终端读取并输入网页，令牌不能交给模型。

两个 LaunchAgent 使用当前构建运行时的绝对路径、专用私有日志与明确 state。退出登录后服务停止，重新登录恢复；不是系统多用户服务。主动卸载须 bootout 两个 job；停止受托管进程前需考虑 KeepAlive，不使用 shutdown 假装永久停止。

## 4. 验收

1. HTTP 集成验证未登录、缺少/错误 CSRF、跨域、未知操作、超长请求均被拒绝。
2. 计划审批通过 UI 预览/确认，错误 ID、失效 reviewId、变化的审批快照和重复提交被拒绝；公开 MCP 仍无审批工具。
3. 任务/计划控制复用状态版本、预算、停止和结果验收规则；发布仍需要 diff 预览且 GitLab 默认关闭。
4. CLI 令牌文件模式不将令牌打印至日志，不允许任意文件路径。
5. 完整测试、插件实际安装结果、MCP initialize/tools/list/health，以及本机后台和页面 HTTP 存活检查。真实模型与 GitLab 写入不属于本次验收，不修改 executionVerified 门禁。
