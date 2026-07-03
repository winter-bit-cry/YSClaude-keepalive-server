# YSClaude Keepalive Server

轻量自托管 Prompt Cache 保活服务。它接收 YSClaude App 上传的最后一次成功使用 `1h` cache 的请求快照，并按 55 分钟间隔自动发送保活请求。

## Zeabur 部署

1. 把本目录推送到一个 GitHub 仓库。
2. 在 Zeabur 新建 Service，选择该 GitHub 仓库。
3. 设置环境变量：

```text
KEEPALIVE_AUTH_TOKEN=换成你自己的长随机令牌
KEEPALIVE_INTERVAL_MS=3300000
FCM_SERVICE_ACCOUNT_FILE=/etc/ysclaude/firebase-service-account.json   # 可选：启用 FCM 推送
```

Firebase 服务账号 JSON 不建议提交到 GitHub。推荐在 Zeabur 的 Config Editor 新增配置文件，路径填 `/etc/ysclaude/firebase-service-account.json`，内容粘贴完整的服务账号 JSON，然后只把上面的 `FCM_SERVICE_ACCOUNT_FILE` 环境变量设为这个短路径。Zeabur 的配置文件会在服务启动时自动挂载；普通文件管理中未挂载的文件重启后可能丢失。

如果部署平台支持较长的多行/单行环境变量，也可以用 `FCM_SERVICE_ACCOUNT_JSON={"type":"service_account",...}` 直接配置。未配置时推送功能静默禁用，其余功能不受影响。

`PORT` 由 Zeabur 注入，不需要手动设置。服务会读取 `process.env.PORT`。

4. 部署完成后打开：

```text
https://你的-zeabur-域名/health
```

看到 `{ "ok": true }` 即可。

5. 在 YSClaude App 中进入：

`设置 -> 对话设置 -> Prompt 缓存 -> 保活方式 -> 远程保活`

填写：

- 服务地址：`https://你的-zeabur-域名`
- 访问令牌：`KEEPALIVE_AUTH_TOKEN`

## 启动

```powershell
cd E:\Desktop\YSClaude-project\YSClaude-keepalive-server
$env:KEEPALIVE_AUTH_TOKEN="换成你自己的长随机令牌"
npm.cmd start
```

默认监听 `0.0.0.0:8789`。可用环境变量调整：

```powershell
$env:HOST="0.0.0.0"
$env:PORT="8789"
$env:KEEPALIVE_AUTH_TOKEN="..."
$env:KEEPALIVE_INTERVAL_MS="3300000"
```

## 接口

- `GET /health`：平台探活，不需要鉴权。
- `GET /v1/keepalive/status`：查看当前保活状态。
- `GET /v1/keepalive/logs?limit=100`：查看最近保活事件日志，包括快照上传、排程、保活成功、失败、跳过。
- `GET /v1/keepalive/inbox?conversationId=...`：查看远程 AI 留给用户、尚未消费的消息。
- `POST /v1/keepalive/inbox/ack`：标记远程消息已消费。
- `GET /v1/keepalive/activity?conversationId=...`：查看远程 AI 自主活动记录。
- `POST /v1/keepalive/activity/ack`：标记自主活动记录已消费。
- `POST /v1/keepalive/snapshot`：上传并覆盖当前对话快照。
- `POST /v1/keepalive/disable`：取消当前对话保活。
- `POST /v1/keepalive/push-token`：上报/轮换 FCM 设备 token（更新所有会话）。

如果设置了 `KEEPALIVE_AUTH_TOKEN`，请求需要带：

```http
Authorization: Bearer <token>
```

查看日志示例：

```powershell
curl.exe -H "Authorization: Bearer <token>" "https://你的-zeabur-域名/v1/keepalive/logs?limit=50"
```

## 行为

- App 每次成功使用 `1h` Prompt Cache 后上传并覆盖快照。
- 后端取消旧定时器，按 `now + 55min` 排下一次保活。
- 服务端会在 `data/state.json` 中保留最近 `MAX_LOG_ENTRIES` 条事件日志，默认 300 条。
- 快照携带 `agentTick.enabled` 时以它决定是否执行远程 AI tick（App 设置里的「远程自主活动」开关，默认开）；旧快照无该字段时退回"包含远程工具配置才 tick"。tick 无需工具也可执行——AI 会被告知已过去的时间，可选择不行动或给用户留言。
- 远程 AI tick 只支持云端记忆库与 Tavily 搜索；不会执行手机本地工具、Shizuku、网页控制或自定义 MCP。
- AI 给用户留言会写入 `pendingMessages`，自主活动会写入 `activityLog`，两者都会更新服务端保存的快照上下文。追加进快照的消息统一为 `assistant` 角色，App 端会逐字插入对话以保持缓存前缀一致。
- AI 给用户留言时，如已配置 `FCM_SERVICE_ACCOUNT_JSON` 或 `FCM_SERVICE_ACCOUNT_FILE`，且 App 上报过设备 token，会通过 FCM 推送系统通知（显示留言前 200 字）；推送失败不影响保活。
- 推荐用 `FCM_SERVICE_ACCOUNT_FILE` 指向服务器上的 Firebase 服务账号 JSON；不要把服务账号密钥提交到仓库。
- 如果保活点落在非保活时段内，本轮保活会取消，缓存自然过期。
- App 后续再次成功使用 cache 后，会重新上传快照并恢复保活循环。
- 如果 App 最后一次成功请求没有使用 `1h` cache，会调用 disable 取消该对话保活。

## 数据与隐私

服务会把请求快照保存到 `data/state.json`，其中包含对话快照和 API Key。只建议部署在你完全控制的机器上，不要暴露到公网，或至少放在 HTTPS / 内网 / 反代鉴权之后。
