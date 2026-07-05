# 给聊天 App 做一套「保活 / 自主活动 / 离线推送」系统

很多聊天 App 都有一个相似的愿望：用户退出 App 后，AI 还能在合适的时间继续“醒来”，看看是否需要做点什么；如果它真的想说话，就把消息推送给用户；用户点开推送后，直接回到对应对话。

这篇教程讲的是一套通用方案，不绑定某个具体 App。你可以把它套到自己的移动端、桌面端或 Web 聊天产品里。

## 目标

我们要实现四件事：

1. 用户最后一次对话后，把必要的上下文快照上传到服务器。
2. 服务器在用户离线时继续保活缓存，避免长上下文失效。
3. AI 可以定时自主醒来，决定要不要给用户留言、做内部记录，或者什么都不做。
4. 如果 AI 给用户留言，服务器发送推送；用户点击推送后，App 打开到对应对话。

这里的“保活”可以是 Prompt Cache 保活，也可以是你自己的会话状态保活。核心思想一样：客户端把可恢复的会话状态交给一个可信服务端，服务端在用户离线时接管定时任务。

## 总体架构

```mermaid
flowchart TD
  A["用户在 App 内聊天"] --> B["App 上传最新会话快照"]
  B --> C["保活服务保存快照和定时器"]
  C --> D{"到触发时间"}
  D -->|"普通保活"| E["调用模型 API 维持缓存"]
  D -->|"AI 自主唤醒"| F["调用模型，让 AI 决定行动"]
  F --> G{"AI 决策"}
  G -->|"给用户留言"| H["写入离线收件箱"]
  H --> I["发送推送"]
  I --> J["用户点击推送"]
  J --> K["App deep link 打开对应对话"]
  G -->|"内部活动"| L["写入活动日志 / 更新上下文"]
  G -->|"不行动"| C
  E --> C
  L --> C
```

服务端不需要知道 App 的完整 UI，只需要知道：

- 会话 ID。
- 模型请求参数。
- 当前消息列表。
- 推送配置。
- 勿扰时间。
- AI 自主活动可用的工具配置。

## 一、客户端上传快照

当用户完成一次成功请求后，客户端把“下一次服务端可以复现请求”的数据上传到服务器。

一个通用快照可以长这样：

```json
{
  "conversationId": "abc-123",
  "updatedAt": 1760000000000,
  "quietHours": {
    "enabled": true,
    "startMinutes": 1380,
    "endMinutes": 420
  },
  "request": {
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "sk-...",
    "model": "your-model",
    "sessionId": "abc-123",
    "messages": [
      {"role": "user", "content": "今天下午提醒我复盘。"},
      {"role": "assistant", "content": "好，我会记得。"}
    ],
    "promptCache": {
      "enabled": true,
      "ttl": "1h"
    }
  },
  "agentTick": {
    "enabled": true
  },
  "push": {
    "provider": "all",
    "ntfy": {
      "serverUrl": "https://ntfy.sh",
      "topic": "ysclaude-long-random-topic",
      "accessToken": ""
    },
    "unifiedpush": {
      "endpoint": "https://ntfy.sh/up/...",
      "p256dh": "base64url-public-key",
      "auth": "base64url-auth-secret"
    }
  }
}
```

关键点：

- `conversationId` 用来让推送点击后回到对应会话。
- `messages` 必须能还原服务端下一次请求。
- `updatedAt` 或服务端接收时间要记录为“用户最后一次上传快照时间”。
- API Key 会保存在服务端，所以这个服务必须是你可信任和控制的。

## 二、普通保活

Prompt Cache 通常有 TTL，比如 1 小时。为了避免过期，服务端可以在 55 分钟左右做一次普通保活。

普通保活并不需要 AI 真的回答用户。通常做法是：

```json
{
  "model": "your-model",
  "messages": "...快照中的 messages...",
  "max_tokens": 0,
  "stream": false
}
```

有些模型或网关不允许 `max_tokens: 0`，可以失败后退回 `max_tokens: 1`。

还有一个常见坑：如果快照最后一条是 `assistant`，有些模型会报错：

```text
This model does not support assistant message prefill.
The conversation must end with a user message.
```

解决办法是只在普通保活请求里临时追加一条 user ping：

```json
{
  "role": "user",
  "content": "[Server keepalive ping] Keep the prompt cache warm. Do not answer this message."
}
```

注意：这条 ping 不要写回真实快照，也不要同步到 App 聊天记录。它只是为了让保活请求合法。

## 三、AI 自主唤醒

普通保活只是维持缓存；自主唤醒才是“AI 离线时也能思考/行动”的核心。

每次 AI 被唤醒时，服务端在原始对话后追加一条临时 user prompt，例如：

```text
Current server time: 2026-07-04T12:00:00.000Z
This wake was planned for: 2026-07-04T12:00:00.000Z
Last user snapshot time: 2026-07-04T10:35:00.000Z
Minutes since last user snapshot: 85

You are running a server-side autonomous activity tick.
You may:
- do nothing
- leave a message for the user
- write an internal activity record

Always return JSON.
Every final JSON object must include "next_awake".
```

为什么要记录 `Last user snapshot time`？

因为普通保活可能每 55 分钟执行一次，但那不代表用户和 AI 聊天了。AI 做决策时真正关心的是“距离用户最后一次说话多久”，而不是“距离服务器上次保活多久”。

推荐让 AI 只返回 JSON：

```json
{
  "action": "user_message",
  "message": "我想提醒你，下午可以留 10 分钟复盘一下今天的重点。",
  "reason": "用户之前提到想要复盘提醒",
  "next_awake": "2026-07-04T14:30:00.000Z"
}
```

也可以是不行动：

```json
{
  "action": "noop",
  "reason": "目前没有必要打扰用户",
  "next_awake": "2026-07-04T15:00:00.000Z"
}
```

或者内部活动：

```json
{
  "action": "agent_activity",
  "summary": "整理了用户今天提到的计划，但暂时不推送。",
  "messagesToAppend": [
    {
      "role": "assistant",
      "content": "[离线活动记录] 用户今天可能需要复盘提醒。"
    }
  ],
  "next_awake": "2026-07-04T14:30:00.000Z"
}
```

## 四、`next_awake` 调度策略

让 AI 自己决定下一次醒来的时间，可以让它不必固定每 55 分钟“打卡”。

服务端可以采用下面的规则：

- 如果 `next_awake <= 当前时间 + 55 分钟`：直接在 `next_awake` 唤醒 AI。
- 如果 `next_awake > 当前时间 + 55 分钟`：55 分钟后执行一次普通保活，然后继续比较。
- 如果 `next_awake` 缺失、格式错误、已经过去，或距离当前太近：兜底为 `当前时间 + 55 分钟`。

伪代码：

```js
function computeNextSchedule(now, nextAwakeAt) {
  const keepaliveInterval = 55 * 60 * 1000;

  if (!nextAwakeAt) {
    return { triggerAt: now + keepaliveInterval, type: "agent-wake" };
  }

  if (nextAwakeAt - now <= keepaliveInterval) {
    return { triggerAt: nextAwakeAt, type: "agent-wake" };
  }

  return { triggerAt: now + keepaliveInterval, type: "keepalive" };
}
```

这样可以同时满足两个目标：

- 缓存不会因为 AI 设定了很久以后才醒而过期。
- AI 不会被迫每 55 分钟都完整思考一次。

## 五、离线收件箱

当 AI 决定给用户留言时，不建议只发推送。推送可能失败，用户也可能换设备。

更稳的做法是先写入服务端离线收件箱：

```json
{
  "id": "msg-001",
  "role": "assistant",
  "content": "我想提醒你，下午可以复盘一下。",
  "createdAt": 1760000000000,
  "source": "remote-agent",
  "consumed": false
}
```

App 启动、回到前台、或打开某个对话时：

1. 请求服务端状态，找出有未消费消息的会话。
2. 拉取 `/inbox?conversationId=...`。
3. 写入本地数据库。
4. 写入成功后调用 `/inbox/ack`。

这样即使推送丢了，消息也不会丢。

## 六、推送与 deep link

推送只负责“叫醒用户”，真实消息以离线收件箱为准。

### 推送工具推荐

不同推送工具适合不同阶段：

| 方案 | 适合场景 | 优点 | 代价 |
| --- | --- | --- | --- |
| FCM / APNs / 厂商推送 | 正式 App、想做到“点系统通知直接进 App” | 原生体验最好，点击通知可直接交给 App 处理 deep link | 接入成本最高，需要移动端证书、token、服务端发送逻辑 |
| Expo Notifications | Expo / React Native 项目 | 比直接接 FCM/APNs 简单，支持通知点击数据 | 仍需要处理权限、token、构建配置 |
| UnifiedPush | Android、自托管/低成本、想让通知由自己的 App 弹出 | 可复用 ntfy 等分发器，通知属于 YSClaude，支持 WebPush 端到端加密 | Android-only，需要用户安装分发器 |
| PushDeer / Bark | 个人 iOS/macOS 用户 | 简单，适合个人设备提醒 | Android/多用户/商业化能力有限 |
| ntfy / Gotify | 自建、内网、开发者工具 | 可自托管、透明、适合告警和私有系统 | 直推模式下系统通知属于 ntfy/Gotify 客户端 |
| Telegram / Discord / Slack Bot | 面向已有社群或团队工作流 | bot API 简单，适合跨设备 | 不适合中国大陆普通用户，也不是原生 App 通知 |

如果目标是“Android 上低成本让通知由 YSClaude 自己弹出”，优先选 UnifiedPush；ntfy 直推可以作为回退通道。

### Deep link 的两种层级

推送 payload 里带一个 URL：

```text
yourapp://chat/{conversationId}
```

用户点击推送后：

1. 系统打开 App。
2. App 解析 deep link。
3. App 同步远程收件箱。
4. App 加载 `conversationId` 对应对话。

在 Android 上，你需要在 manifest 中声明 scheme：

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="yourapp" />
</intent-filter>
```

如果你使用 Expo Router，可以准备一个类似 `/chat/[id]` 的中转页：

```ts
const { id } = useLocalSearchParams();
await syncRemoteInbox();
await loadConversation(id);
router.replace("/");
```

### UnifiedPush 与 ntfy 的分工

ntfy 直推模式最简单：服务端把通知发到 topic，用户在 ntfy App 中订阅并收通知。

UnifiedPush 模式下，ntfy App 只是后台分发器。YSClaude App 注册后拿到 `endpoint/p256dh/auth` 并上报服务端；服务端用 RFC 8291 WebPush 加密正文，分发器看不到明文；手机收到后由 YSClaude 解密并弹出自己的原生通知。

## 七、自主活动工具

自主活动工具要谨慎开放。

通用建议：

- 优先开放云端只读工具，例如记忆搜索、日记查询、网页搜索。
- 不要默认开放手机本地控制、文件系统、命令执行、支付、发消息等高风险工具。
- 每个工具都要有超时、错误处理和结果摘要。
- 工具调用结果可以写进 activity log，方便用户审计。

工具定义可以是 OpenAI-compatible function calling：

```json
{
  "type": "function",
  "function": {
    "name": "search_memory",
    "description": "Search long-term memory.",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {"type": "string"}
      },
      "required": ["query"]
    }
  }
}
```

不同 App 可以替换自己的工具集，但服务端调度、收件箱和推送机制不需要变化。

## 八、勿扰与清理策略

离线 AI 最容易让用户不舒服的点是“它在不该出现的时候出现”。

推荐至少支持勿扰时间：

- 进入勿扰时间后，不再保活。
- 清空服务端快照和 timer。
- 清空待收件箱和活动日志。
- 持久化写回空状态，避免服务重启后恢复。

这是一种很强的隐私边界：到点以后，服务端不再保留可继续行动的上下文。

如果你想保留历史日志，也可以只清空快照和 API Key，把日志脱敏后保留。但默认建议更保守：全清。

## 九、安全边界

这套系统会保存模型 API Key 和对话快照，所以必须认真处理安全问题：

- 服务端必须有鉴权，例如 Bearer token。
- 尽量部署在你控制的机器或可信平台。
- 不要把管理面板裸露到公网。
- 尽量使用 HTTPS。
- 不要记录完整 API Key 到日志。
- 推送内容只放摘要，不放敏感长文本。
- AI 自主活动要有开关，用户能随时关闭。

## 十、最小接口清单

一个可用的通用服务至少需要这些接口：

```text
GET  /health
GET  /status
POST /snapshot
POST /disable
GET  /inbox?conversationId=...
POST /inbox/ack
GET  /activity?conversationId=...
POST /activity/ack
POST /push-test
```

其中最重要的是：

- `/snapshot`：客户端上传最新状态。
- `/inbox`：客户端同步 AI 离线留言。
- `/disable`：客户端关闭保活。

## 总结

这套方案的核心不是“让 AI 一直在线”，而是把离线行为拆成几个清楚、可控、可审计的模块：

- 快照负责恢复上下文。
- 普通保活负责维持缓存。
- 自主 tick 负责让 AI 在合适时间醒来。
- `next_awake` 负责让 AI 自己安排节奏。
- 离线收件箱负责保证消息不丢。
- 推送和 deep link 负责把用户带回正确对话。
- 勿扰清理负责给用户一个明确的边界。

把这些边界做好以后，AI 的离线存在感才会更像“可靠的助手”，而不是不可控的后台进程。
