# YSClaude Keepalive Server

轻量自托管 Prompt Cache 保活服务。它接收 YSClaude App 上传的最后一次成功使用 `1h` cache 的请求快照，并按 55 分钟间隔自动发送保活请求。

## Zeabur 部署

1. 把本目录推送到一个 GitHub 仓库。
2. 在 Zeabur 新建 Service，选择该 GitHub 仓库。
3. 设置环境变量：

```text
KEEPALIVE_AUTH_TOKEN=换成你自己的长随机令牌
KEEPALIVE_INTERVAL_MS=3300000
```

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
- `POST /v1/keepalive/snapshot`：上传并覆盖当前对话快照。
- `POST /v1/keepalive/disable`：取消当前对话保活。

如果设置了 `KEEPALIVE_AUTH_TOKEN`，请求需要带：

```http
Authorization: Bearer <token>
```

## 行为

- App 每次成功使用 `1h` Prompt Cache 后上传并覆盖快照。
- 后端取消旧定时器，按 `now + 55min` 排下一次保活。
- 如果保活点落在非保活时段内，本轮保活会取消，缓存自然过期。
- App 后续再次成功使用 cache 后，会重新上传快照并恢复保活循环。
- 如果 App 最后一次成功请求没有使用 `1h` cache，会调用 disable 取消该对话保活。

## 数据与隐私

服务会把请求快照保存到 `data/state.json`，其中包含对话快照和 API Key。只建议部署在你完全控制的机器上，不要暴露到公网，或至少放在 HTTPS / 内网 / 反代鉴权之后。
