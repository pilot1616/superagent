# Codex 本地任务服务使用说明

当前是开发预览；先读 [实施/验收状态](codex-implementation-status.md)。**P0 未完成，因此真实编码 Worker 被禁用。** 以下步骤可验证本地任务、MCP 与监督流程，不会在初始化时调用模型或推送代码。

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

当前只接受无 origin 的本地仓库，或使用不含嵌入凭据的 github.com 标准 HTTPS/SSH origin；其他 Git 服务器暂不支持。不要把访问令牌写入 remote URL。

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

批准必须在真实交互终端内查看结构化摘要并完整输入该 approval ID；没有 `--yes` 或 `approve_all`。当前即使批准启动，真实执行仍会被 P0 门禁拒绝，并显示失败原因，不会启动模型进程。

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
  --state /absolute/path/to/private-state
```

脚本验证构建后的 CLI 和当前 Node 路径，在副本 `.mcp.json` 写入它们的实际绝对路径；不将开发机路径写回通用源码清单。副本仍依赖当前源码的 dist/node_modules，移动源码后必须重新配置。

此命令不修改 personal marketplace、Codex 配置或启动服务。实际 marketplace 注册/安装应在用户明确授权后用当前 plugin-creator 流程完成，并在新 Codex 会话验收。当前尚未实际安装验证，不把“生成副本”称为“已装入 Codex”。

MCP 可直接开发调试：

```sh
node packages/dist/service/src/cli.js mcp bridge
```

该进程 stdout 仅用于 MCP 协议，不是交互式 shell；诊断走 stderr。Bridge 没有 approve、任意 shell、SQL 或文件读取工具；没有服务时返回不可用，不自动起守护进程。

## 5. 只读本地看板

在可信交互终端运行：

```sh
node packages/dist/service/src/cli.js panel --port 0
```

仅监听 `127.0.0.1` 的随机端口。终端打印地址与独立看板登录令牌，在页面表单输入；不把 token 放 URL，不发给模型。登录会话一小时过期。审批、创建和发布通过可信 CLI，不开放网页写接口。

看板包含任务列表、人工停止、输入、分配、报告、PR、审批摘要、分页事件与健康状态。它不嵌入 Codex 原生 UI，也不自动打开浏览器或注册系统后台服务。

## 6. 发布：默认关闭，先做隔离仓库验收

只有在人为确认独立 GitHub 测试仓库和最小权限凭据后，才在停服时配置 `service.json` 的 `githubEnabled` 并由用户提供 state 下的 `github.token`（0600）。凭据不进入 Worker 环境、manifest、Git argv 或面板。当前未做真实网络交付验收，不建议用于生产。

ready 后，先 `inspect TICKET_ID` 获取 head SHA，再用 `task publish` 申请（传 ticketId/expectedRevision/headSha/requestId）。然后：

```sh
node packages/dist/service/src/cli.js publish-preview APPROVAL_ID \
  --author-name 'YOUR_COMMIT_AUTHOR' --author-email 'YOUR_COMMIT_EMAIL'
node packages/dist/service/src/cli.js approve APPROVAL_ID
```

预览将当前 head、完整 tree（含未跟踪文件）、base、分支、作者、标题和说明哈希绑定；批准时重新计算。默认拒绝符号链接、子模块、危险 Git 配置及单文件超过 20MB 的交付。只进行非强推和本任务 PR 创建/更新，不自动 merge、关闭其他 PR 或删除分支。

仅轮询已绑定 PR 的评论、审查和 CI；失败退避，连续六次失败停止自动读取，人工 `observe TICKET_ID` 可核查并重置。暂时全量分页重读并持久去重，不用未经证实的时间游标跳过反馈。

无 PR 的本地 ready 结果可由用户运行 `complete TICKET_ID` 明确接受。PR 未合并不冒充完成。

## 7. 备份、停止、恢复

```sh
node packages/dist/service/src/cli.js backup
node packages/dist/service/src/cli.js shutdown
```

backup 使用 SQLite online backup API，在私有 state/backups 输出数据库快照；不粗暴复制活动 WAL 数据库。备份也含任务文本，按敏感数据管理。还应由用户备份 service.json/profile 配置；凭据单独管理。

异常退出后，`recover-lock` 只有在记录 PID 已不存在时才能删除锁；PID 被复用时拒绝自动处理，不 kill 任意进程。重启后此前 running/uncertain 的工作进入 reconciling，不自动重发 turn/input/push。

用户核对线程、进程、工作树和外部交付后，运行：

```sh
node packages/dist/service/src/cli.js reconcile TICKET_ID \
  --note '具体核对过的线程、进程与输入证据' --disposition settled
```

`pending` 表示核对后明确允许这些不确定输入在下一次授权执行中重投，不是“无损恢复”。两种选择都保留停止锁；随后仍须申请 resume。发布核对使用 `reconcile-publish TICKET_ID`，仅在远端唯一 PR 和持久 commit SHA 一致时落库，不进行网络写入。

代码回滚用新增 revert 提交，数据库回滚前先停服、备份并检查 schema。未提供自动恢复旧版本数据的承诺。

## 8. 本地分发包

```sh
cd packages
npm pack --pack-destination /absolute/path/to/output-directory
```

prepack 会构建并只打包白名单中的新运行时。运行包依赖官方 MCP SDK/Zod 与面板相关 npm 依赖，不依赖 DSH；不会夹带 SQLite、凭据、测试仓库、旧源码、插件安装缓存或 node_modules。这里不自动 `npm install -g`，不上传 npm/GitHub。

真实模型执行会把任务与必要代码上下文发送到所选模型供应商；本地 SQLite 不代表离线推理。
