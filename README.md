# YSClaude Keepalive Server

轻量自托管的 YSClaude 远程 Prompt Cache 保活与 AI 定时唤醒服务。

它接收 YSClaude App 上传的最后一次成功使用 `1h` Prompt Cache 的请求快照，保存到服务端，并在 App 离线时继续维持缓存、执行远程 AI 自主 tick、发送微信推送，并在用户点击 WxPusher 消息后打开 App 对应对话。

## 功能

- 远程保活：按 `KEEPALIVE_INTERVAL_MS` 保持 `1h` Prompt Cache，默认 55 分钟。
- AI 自主唤醒：AI 每次被唤醒时必须返回 `next_awake`，服务端据此安排下一次 AI tick。
- 长间隔补保活：如果 `next_awake` 距当前时间超过 55 分钟，服务端会先做普通保活，到点后再唤醒 AI。
- 点击推送打开对话：WxPusher 推送带 `ysclaude://chat/{conversationId}` deep link，点击后打开 YSClaude App 对应对话。
- 远程收件箱：AI 主动留言写入 `pendingMessages`，App 下次启动或打开对话时同步。
- 远程活动日志：AI 内部活动写入 `activityLog`，可由 App 同步。
- 勿扰清空：每天进入勿扰时间后，服务端会清空所有快照、保活 timer、日志和待收件数据。
- 管理面板：`/admin` 可查看快照、下次保活、下次 AI 唤醒、待收件数和日志。

## Zeabur 部署

1. 把本目录推送到 GitHub 仓库。
2. 在 Zeabur 新建 Service，选择该 GitHub 仓库。
3. 设置环境变量：

```text
KEEPALIVE_AUTH_TOKEN=换成你自己的长随机令牌
KEEPALIVE_INTERVAL_MS=3300000

# Server酱，可选
SERVERCHAN_SENDKEY=

# WxPusher，可选但推荐，用于点击消息打开 App
WXPUSHER_APP_TOKEN=AT_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WXPUSHER_UIDS=UID_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WXPUSHER_TOPIC_IDS=
YSCLAUDE_APP_DEEPLINK_BASE=ysclaude://chat/
```

`PORT` 由 Zeabur 注入，不需要手动设置。服务会读取 `process.env.PORT`。

4. 部署完成后打开：

```text
https://你的-zeabur-域名/health
```

看到 `{ "ok": true }` 即可。

管理面板在：

```text
https://你的-zeabur-域名/admin
```

5. 在 YSClaude App 中进入：

`设置 -> 对话设置 -> Prompt 缓存 -> 保活方式 -> 远程保活`

填写：

- 服务地址：`https://你的-zeabur-域名`
- 访问令牌：`KEEPALIVE_AUTH_TOKEN`
- 推送通道：Server酱、WxPusher 或 both

## 本地启动

```powershell
cd E:\Desktop\YSClaude-project\YSClaude-keepalive-server
$env:KEEPALIVE_AUTH_TOKEN="换成你自己的长随机令牌"
$env:WXPUSHER_APP_TOKEN="AT_xxx"
$env:WXPUSHER_UIDS="UID_xxx"
npm.cmd start
```

默认监听 `0.0.0.0:8789`。可用环境变量调整：

```powershell
$env:HOST="0.0.0.0"
$env:PORT="8789"
$env:KEEPALIVE_INTERVAL_MS="3300000"
```

## AI 定时唤醒规则

服务端 AI tick 的提示词会告诉 AI：

- 当前服务器时间。
- 本次计划唤醒时间。
- 用户/App 最后一次上传快照时间。
- 距离用户最后一次在 App 侧对话/上传快照过去了多少分钟。
- 最终 JSON 必须包含 `next_awake`。

AI 返回示例：

```json
{"action":"noop","reason":"暂时不需要行动","next_awake":"2026-07-04T12:30:00.000Z"}
```

也支持：

```json
{"action":"user_message","message":"我想起一件事。","reason":"需要提醒用户","nextAwakeAt":"2026-07-04T12:30:00.000Z"}
```

或以分钟为单位：

```json
{"action":"noop","reason":"稍后再看","next_awake_minutes":90}
```

调度逻辑：

- `next_awake <= 当前时间 + 55 分钟`：直接按 `next_awake` 唤醒 AI。
- `next_awake > 当前时间 + 55 分钟`：先在 55 分钟后执行一次普通保活，再循环比较。
- `next_awake` 缺失、格式错误、已过期或距离当前不足 30 秒：兜底为 `当前时间 + 55 分钟`。

普通保活不会刷新 `lastUserSnapshotAt`。因此，如果用户最后一次说话后 55 分钟 AI 被唤醒，AI 留言后又设置 30 分钟后再醒，下一次提示会告诉 AI 距离用户最后一次对话已经约 85 分钟。

## 推送

支持 Server酱和 WxPusher。

Server酱：

- 支持经典版 `SCT...`，走 `sctapi.ftqq.com`。
- 支持 Server酱³ `sctp{uid}t...`，走 `push.ft07.com`。
- SendKey 优先使用 App 快照上报配置，没有时使用环境变量 `SERVERCHAN_SENDKEY`。

WxPusher：

- 使用 `WXPUSHER_APP_TOKEN`、`WXPUSHER_UIDS`、`WXPUSHER_TOPIC_IDS`。
- AI 给用户留言时，服务端发送 WxPusher 消息。
- 推送 payload 会带 `url`，默认是 `ysclaude://chat/{conversationId}`。
- 点击消息后，Android 会打开 YSClaude App 并跳转到对应会话。
- `YSCLAUDE_APP_DEEPLINK_BASE` 可改为自定义格式，支持 `{conversationId}` 占位，例如：

```text
YSCLAUDE_APP_DEEPLINK_BASE=ysclaude://chat/{conversationId}
```

推送失败不会中断保活或 AI 定时任务。

## 勿扰时间

App 上传快照时会带勿扰时间配置。

当前服务端语义是：每天到勿扰开始时间后，清空一切服务端数据，包括：

- 所有对话快照。
- 所有保活 timer。
- 所有 AI 定时唤醒 timer。
- 待消费消息和活动日志。
- `data/state.json` 中的持久化数据。

如果某次快照计算出的下一次触发时间已经落入勿扰时间，服务端也会直接清空并返回：

```json
{"ok":true,"status":"cleared","reason":"quiet-hours"}
```

## 普通保活兼容

有些模型或网关要求对话必须以 `user` 消息结尾。如果 AI 主动留言后用户没有回复，快照最后一条会是 `assistant`，普通保活可能报错：

```text
This model does not support assistant message prefill.
```

服务端会在普通保活请求中临时追加一条 user ping：

```text
[Server keepalive ping] Keep the prompt cache warm. Do not answer this message.
```

这条消息只用于本次保活请求，不会写入服务端快照，也不会同步到 App 对话。

## 接口

- `GET /health`：平台探活，不需要鉴权。
- `GET /v1/keepalive/status`：查看当前保活、下次 AI 唤醒、推送和待收件状态。
- `GET /v1/keepalive/logs?limit=100`：查看最近事件日志。
- `GET /v1/keepalive/inbox?conversationId=...`：查看远程 AI 留给用户、尚未消费的消息。
- `POST /v1/keepalive/inbox/ack`：标记远程消息已消费。
- `GET /v1/keepalive/activity?conversationId=...`：查看远程 AI 自主活动记录。
- `POST /v1/keepalive/activity/ack`：标记自主活动记录已消费。
- `POST /v1/keepalive/snapshot`：上传并覆盖当前对话快照。
- `POST /v1/keepalive/disable`：取消当前对话保活。
- `POST /v1/keepalive/delete`：删除指定对话快照，JSON body: `{ "conversationId": "..." }`。
- `DELETE /v1/keepalive/conversations/:conversationId`：删除指定对话快照。
- `POST /v1/keepalive/push-token`：上报或更新推送配置。
- `POST /v1/keepalive/push-test`：发送测试推送。

如果设置了 `KEEPALIVE_AUTH_TOKEN`，请求需要带：

```http
Authorization: Bearer <token>
```

查看日志示例：

```powershell
curl.exe -H "Authorization: Bearer <token>" "https://你的-zeabur-域名/v1/keepalive/logs?limit=50"
```

删除快照示例：

```powershell
curl.exe -X POST `
  -H "Authorization: Bearer <token>" `
  -H "Content-Type: application/json" `
  -d "{\"conversationId\":\"要删除的 conversationId\"}" `
  "https://你的-zeabur-域名/v1/keepalive/delete"
```

## 数据与隐私

服务会把请求快照保存到 `data/state.json`，其中包含对话快照和 API Key。只建议部署在你完全控制的机器上，不要暴露到公网，或至少放在 HTTPS / 内网 / 反代鉴权之后。

进入勿扰时间后，服务端会清空 `state.conversations` 和 `state.logs` 并写回 `data/state.json`。
