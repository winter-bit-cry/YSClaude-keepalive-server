# YSClaude Keepalive Server

YSClaude Keepalive Server 是给 YSClaude App 使用的远程 Prompt Cache 保活、AI 定时唤醒和离线消息同步服务。

App 会把最近一次可恢复的对话请求快照上传到服务端。用户离开 App 后，服务端继续按计划维持缓存，并在合适的时间唤醒 AI，让 AI 决定是否给用户留言、记录一次自主活动，或者暂时不打扰。用户下次打开 App 或点击推送进入对话时，本地会同步服务端的离线收件箱和活动记录。

具体原理、部署流程和设计取舍见 [TUTORIAL.md](./TUTORIAL.md)。

当前推送方式只保留两种，二选一：

- 钉钉自定义机器人
- WxPusher

## 功能

- 远程保活：按 `KEEPALIVE_INTERVAL_MS` 维持 `1h` Prompt Cache，默认 55 分钟。
- AI 定时唤醒：AI 每次被唤醒时必须返回下一次 `next_awake`，服务端据此安排下一轮。
- 长间隔补保活：如果 `next_awake` 距离当前时间超过保活间隔，服务端会先做普通保活，到点后再唤醒 AI。
- 离线收件箱：AI 主动给用户的消息写入 `pendingMessages`，App 下次同步后写回本地聊天记录。
- 自主活动记录：AI 的工具活动、内部判断、`noop` 理由会写入 `activityLog`，App 同步后也会写回本地聊天记录。
- 推送提醒：AI 选择给用户留言时，通过钉钉或 WxPusher 推送消息预览和 deep link。
- 勿扰清理：进入勿扰时间后，服务端清空快照、定时器、日志和待同步数据。
- 管理面板：`/admin` 可查看快照、下次保活、下次 AI 唤醒、推送状态和日志。

## 环境变量

```text
PORT=8789
HOST=0.0.0.0
KEEPALIVE_AUTH_TOKEN=replace-with-a-long-random-token
KEEPALIVE_INTERVAL_MS=3300000

WXPUSHER_APP_TOKEN=
WXPUSHER_UIDS=
WXPUSHER_TOPIC_IDS=

DINGTALK_WEBHOOK=
DINGTALK_SECRET=
DINGTALK_AT_MOBILES=
DINGTALK_TITLE=YSClaude

YSCLAUDE_APP_DEEPLINK_BASE=ysclaude://chat/
```

说明：

- `KEEPALIVE_AUTH_TOKEN`：服务端鉴权令牌，App 设置里的访问令牌要与它一致。
- `KEEPALIVE_INTERVAL_MS`：普通保活间隔，默认推荐 `3300000`，即 55 分钟。
- `YSCLAUDE_APP_DEEPLINK_BASE`：推送点击后打开 App 对话的 deep link 前缀。
- `DINGTALK_TITLE`：钉钉 markdown 的内部标题字段。当前可见正文只包含消息预览和“打开 YSClaude”链接。

## Zeabur 部署

1. 把本目录推送到 GitHub 仓库。
2. 在 Zeabur 新建 Service，选择该 GitHub 仓库。
3. 设置环境变量，至少填写：

```text
KEEPALIVE_AUTH_TOKEN=换成你自己的长随机令牌
KEEPALIVE_INTERVAL_MS=3300000
YSCLAUDE_APP_DEEPLINK_BASE=ysclaude://chat/
```

4. 按你选择的推送方式填写钉钉或 WxPusher 配置。
5. 部署完成后打开：

```text
https://你的-zeabur-域名/health
```

看到 `{ "ok": true }` 即可。

管理面板：

```text
https://你的-zeabur-域名/admin
```

## App 配置

在 YSClaude App 中进入：

```text
设置 -> 对话设置 -> Prompt 缓存 -> 保活方式 -> 远程保活
```

填写：

- 服务地址：`https://你的-zeabur-域名`
- 访问令牌：`KEEPALIVE_AUTH_TOKEN`
- 推送通道：选择 `钉钉` 或 `WxPusher`

App 会在上传快照时把当前会话的推送配置一并上报。服务端也支持用环境变量作为兜底配置。

## 钉钉推送

钉钉使用群自定义机器人 Webhook。

服务端兜底环境变量：

```text
DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=...
DINGTALK_SECRET=SEC...
DINGTALK_AT_MOBILES=
DINGTALK_TITLE=YSClaude
```

推送内容格式：

```text
消息预览

打开 YSClaude
```

点击链接后会通过 deep link 打开对应会话。正文不再显示额外标题行。

## WxPusher 推送

WxPusher 使用 AppToken + UID 或 Topic ID。

服务端兜底环境变量：

```text
WXPUSHER_APP_TOKEN=AT_xxx
WXPUSHER_UIDS=UID_xxx
WXPUSHER_TOPIC_IDS=
```

说明：

- `WXPUSHER_UIDS` 可填写一个或多个 UID，用英文逗号、空格或分号分隔。
- `WXPUSHER_TOPIC_IDS` 可填写一个或多个 Topic ID。
- App 也可以上报每个会话自己的 WxPusher 配置，优先级高于服务端兜底配置。

## 本地启动

```powershell
cd E:\Desktop\YSClaude-project\YSClaude-keepalive-server
$env:KEEPALIVE_AUTH_TOKEN="换成你自己的长随机令牌"
$env:DINGTALK_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=..."
npm.cmd start
```

默认监听 `0.0.0.0:8789`。

## AI 定时唤醒

服务端 AI tick 会告诉 AI：

- 当前服务端时间。
- 本次计划唤醒时间。
- 用户/App 最后一次上传快照时间。
- 距离用户最后一次在 App 侧对话已经过去多久。
- 最终必须返回 JSON，并包含 `next_awake`。

示例：

```json
{"action":"noop","reason":"当前用户可能正在忙，暂时不打扰。","next_awake":"2026-07-04T12:30:00.000Z"}
```

也可以给用户留言：

```json
{"action":"user_message","message":"我想提醒你，下午可以留 10 分钟复盘一下。","reason":"用户之前提到需要复盘提醒。","next_awake":"2026-07-04T14:30:00.000Z"}
```

也可以只做内部活动：

```json
{"action":"agent_activity","summary":"整理了用户今天提到的计划，暂时不推送。","messagesToAppend":[{"role":"assistant","content":"[远程自主活动记录] 整理了今天的复盘提醒。"}],"next_awake":"2026-07-04T14:30:00.000Z"}
```

`noop` 的 `reason` 也会写入 activity，并在 App 同步后写回本地聊天记录。

## 同步机制

AI 给用户留言时：

1. 服务端写入 `pendingMessages`。
2. 服务端发送钉钉或 WxPusher 推送。
3. 用户打开 App 后，App 拉取 `/v1/keepalive/inbox`。
4. App 写入本地数据库。
5. App 调用 `/v1/keepalive/inbox/ack` 确认消费。

AI 自主活动或 `noop` 判断时：

1. 服务端写入 `activityLog`。
2. App 拉取 `/v1/keepalive/activity`。
3. 如果 activity 带有 `appendedMessages`，App 写入本地聊天记录。
4. App 调用 `/v1/keepalive/activity/ack` 确认消费。

推送失败不会中断保活或 AI 定时任务。真实消息以服务端收件箱和活动记录为准。

## 勿扰时间

App 上传快照时会带勿扰时间配置。

当前服务端语义是：每天进入勿扰开始时间后，清空一切服务端数据，包括：

- 所有对话快照。
- 所有保活 timer。
- 所有 AI 定时唤醒 timer。
- 待消费消息和活动记录。
- `data/state.json` 中的持久化数据。

如果某次快照计算出的下一次触发时间已经落入勿扰时间，服务端也会直接清空并返回：

```json
{"ok":true,"status":"cleared","reason":"quiet-hours"}
```

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
- `POST /v1/keepalive/delete`：删除指定对话快照。
- `DELETE /v1/keepalive/conversations/:conversationId`：删除指定对话快照。
- `POST /v1/keepalive/push-token`：上报或更新推送配置。
- `POST /v1/keepalive/push-test`：发送测试推送。

如果设置了 `KEEPALIVE_AUTH_TOKEN`，请求需要带：

```http
Authorization: Bearer <token>
```

## 数据与隐私

服务端会把请求快照保存到 `data/state.json`，其中包含对话快照和 API Key。只建议部署在你完全控制的机器或可信平台上，并放在 HTTPS、内网或反代鉴权之后。

进入勿扰时间后，服务端会清空 `state.conversations` 和 `state.logs`，并写回 `data/state.json`。

## 开源协议

本项目采用 GPL-3.0 开源协议。
