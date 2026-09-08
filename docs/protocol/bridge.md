# 桥接协议 v1

bilibili-notify（下称 **BN**）与**机器人框架桥接插件**（下称**桥**）之间的线上协议。

写给插件作者看。BN 侧的类型定义在 `apps/contract/src/bridge.ts`，校验在
`apps/server/src/bridge/protocol.ts` —— 两处与本文档任何不一致，**以本文档为准**并提 issue。

---

## 1. 这东西是干嘛的

桥是跑在 koishi / AstrBot 里的一个插件。它**主动连上 BN**，把宿主里已经登录好的 bot
借给 BN 用：BN 把推送发给桥，桥用某个 bot 发出去；用户在群里 / 私聊说的话，桥回传给 BN。

BN 不认识 telegram、discord 或者别的任何平台 —— 那些是**你的框架**已经做好的事。
BN 只认识「桥」这一档，桥后面挂着什么，是握手时你告诉它的。

```
┌──────────┐   WebSocket   ┌──────────┐   框架自己的适配器   ┌──────────┐
│    BN    │ ◄──────────── │    桥    │ ◄─────────────────► │  各平台  │
└──────────┘   桥主动连    └──────────┘                     └──────────┘
```

**为什么是桥连 BN、不是 BN 连桥**：BN 常跑在 NAS / 内网里，外网进不来；而框架实例
通常出得去。这跟 OneBot 的 ws-reverse 是同一个方向。

**重连退避归你**。BN 不会来找你，断了就是断了。

---

## 2. 连接与鉴权

| | |
|---|---|
| 端点 | `ws://<BN 地址>/bridge`（BN 挂在 https 后面时用 `wss://`） |
| 鉴权 | HTTP upgrade 请求头 `Authorization: Bearer <token>` |
| 编码 | JSON 文本帧，一帧一个对象，`type` 是判别子 |

token 在 BN 的**拓展页**里生成，一条桥接入一个。

**token 不放在 URL、也不放在帧里**：URL 会进反向代理的访问日志。upgrade 被拒时 WebSocket
根本不会建起来 —— 你的客户端收到的是 `unexpected-response`（Node 的 `ws`）或握手异常
（Python 的 `websockets`）。**两种拒法要分开对待**：

| 状态码 | 意思 | 该不该重连 |
|---|---|---|
| `401` | token 不对 / 已吊销 | ❌ 当成**配置错误**显示给用户，别无限重连 |
| `503` | token 认得，只是这会儿不收（桥接模块关着 / 这条接入被停用） | ✅ 退避重连，用户把开关拨回来你就自己回来了 |

连上之后你必须在 **10 秒**内发出 `hello`，否则 BN 断连（close `4004`）。

---

## 3. 协议版本

`hello` 里报 `{ major, minor }`。BN **只看 `major`**：

- `major` 相同 → 接受，`minor` 差多少、谁大谁小都不管。
- `major` 不同 → BN 不发 `welcome`，直接断连（close `4002`）。**别重连**，升级插件或升级 BN。

对应的兼容承诺：

| 改动 | 版本 |
|---|---|
| 加一个可选字段、加一种新帧类型、能力表加一项 | 升 `minor` |
| 改已有字段的含义、删字段、改判别子取值 | 升 `major` |

当前：**`1.0`**。

---

## 4. 帧总表

**桥 → BN**

| `type` | 什么时候发 |
|---|---|
| `hello` | 连上后的第一帧，且只此一次 |
| `bots` | bot 名单变了（**全量快照**） |
| `inbound` | 收到一条订阅范围内的用户消息 |
| `result` | 回一次 `send` |
| `pong` | 回一次 `ping` |

**BN → 桥**

| `type` | 什么时候发 |
|---|---|
| `welcome` | 收下 `hello` 之后 |
| `send` | 有一条推送要发 |
| `ping` | 心跳 |
| `error` | 出了错但还不至于断连 |

---

## 5. 桥 → BN

### 5.1 `hello`

```jsonc
{
  "type": "hello",
  "protocol": { "major": 1, "minor": 0 },
  "bridge": {
    "kind": "koishi",        // "koishi" | "astrbot"
    "name": "家里那台",       // 可选，面板上显示
    "version": "0.1.0"       // 可选，插件版本，排障用
  },
  "bots": [ /* 见 5.2 的 bot 形状，握手时给全量 */ ]
}
```

`bridge.kind` **只用于显示与排障** —— BN 对两种桥的处理完全相同。

### 5.2 `bots`（全量快照）

```jsonc
{
  "type": "bots",
  "bots": [
    {
      "botId": "telegram:12345",   // 这条桥连接内唯一即可；BN 拿它回指「用哪个 bot 发」
      "platform": "telegram",      // 开放词表，随你的框架叫什么就叫什么
      "name": "阿伦",               // 可选，显示名
      "selfId": "12345",           // 可选，bot 在平台上的账号。仅供显示
      "capabilities": { /* 见 §7 */ }
    }
  ]
}
```

**是快照，不是增量。** bot 名单一有变化就整份重发，`bots: []` 合法（宿主里一个 bot 都没有）。

协议只规定「你必须推」，不规定你怎么察觉：koishi 有 `login-added` / `login-removed` /
`login-updated` 三个事件；AstrBot 没有插件钩子，轮询 `get_insts()` 比较一下再发即可。

> `botId` 要**跨重启稳定**。BN 把它记在推送目标里，换了就等于用户配的目标指向了一个
> 不存在的 bot（BN 不会删目标，只会标成不可用）。

### 5.3 `inbound`

只发 BN 在 `welcome` 里订阅了的那些（见 §8），**在你这一侧过滤**。

```jsonc
{
  "type": "inbound",
  "botId": "telegram:12345",
  "platform": "telegram",
  "message": { "scope": "private", "userId": "u1", "text": "订阅列表" }
}
```

`message` 两种形状，`scope` 判别：

```jsonc
{ "scope": "private", "userId": "…", "text": "…" }
{ "scope": "group", "groupId": "…", "userId": "…", "text": "…" }
```

- **频道消息归到 `group`**：协议只有这两支，频道 / 子频道怎么映射到 `groupId` 由你决定，
  只要跟你在 `bots` 里报的、和用户在 BN 面板上填的地址是同一套编号就行。
- `text` 是**纯文本**。消息里的图片、表情、回复引用等元素请自行剥掉。
- 分享卡 / 小程序卡消息：如果你能解出里面的链接，把链接拼进 `text` 一起发上来 ——
  这正是 `shareCardLinks` 能力位描述的事（见 §7）。
- **别回传 bot 自己发的消息**，会打转。

### 5.4 `result`

```jsonc
{ "type": "result", "id": "…", "ok": true }
{ "type": "result", "id": "…", "ok": false, "err": "bot 掉线了" }
```

`id` 从对应的 `send` 帧原样带回。**每条 `send` 都要回一条 `result`** —— 失败也要回，
BN 拿它写推送历史。`err` 直接展示给用户，请写人话。

**BN 最多等 30 秒**，超时那条就按失败记账了。晚到的回执 BN 会忽略（不会断你），但那条
推送不会被翻案 —— 图下载得慢也请尽量在窗口内回一个结果，别让用户看到一条假的失败。

**断线时 BN 把在飞的全部就地判失败，不排队也不补推**：推送有时效，补推一条三小时前的
「正在直播」比不推更糟。所以重连之后不必替 BN 补发任何东西。

### 5.5 `pong`

```jsonc
{ "type": "pong" }
```

收到 `ping` 就回。

---

## 6. BN → 桥

### 6.1 `welcome`

```jsonc
{
  "type": "welcome",
  "protocol": { "major": 1, "minor": 0 },
  "server": { "version": "0.10.1" },
  "inbound": { "private": true, "group": "with-links" }
}
```

### 6.2 `send`

```jsonc
{
  "type": "send",
  "id": "…",                       // 回 result 时原样带回
  "botId": "telegram:12345",
  "platform": "telegram",
  "target": {
    "scope": "group",              // "group" | "private" | "channel"
    "address": "-1001234567890",
    "parentAddress": "…"           // 可选。频道消息里的父级（服务器 / 频道）
  },
  "message": { /* 见 6.3 */ }
}
```

### 6.3 `message`

`kind` 判别，五种：

```jsonc
{ "kind": "text", "text": "…" }

{ "kind": "image", "url": "…", "mime": "image/jpeg", "caption": "…" }   // caption 可选

{ "kind": "composite", "segments": [
    { "type": "text", "text": "…" },
    { "type": "image", "url": "…", "mime": "image/png" },
    { "type": "link", "href": "https://…", "title": "…" },   // title 可选
    { "type": "at-all" }
] }

{ "kind": "forward-images",
  "images": [ { "url": "…", "width": 1080, "height": 1920 } ],   // 宽高可选
  "forward": true }

{ "kind": "miniapp-card",
  "title": "…", "desc": "…", "picUrl": "…",
  "path": "pages/video/video?bvid=…",   // 小程序页面路径
  "jumpUrl": "https://www.bilibili.com/video/…" }   // 网页链接
}
```

降级规则（做不了就降级，**别整条丢掉**）：

| | 做不了的时候 |
|---|---|
| `at-all` 段 | 发成一句「@全体成员」文字 |
| `forward: true` | 退成普通多张图 |
| `miniapp-card` | 发成 `title` + `jumpUrl` 的文字 |
| `link` 段 | 发成 `title` + `href` 的文字 |

能不能做，请如实报进能力表（§7）—— BN 会据此**提前**换一种发法，比事后降级好看得多。

### 6.4 `error`

```jsonc
{ "type": "error", "message": "…" }
```

出错了但连接还留着（比如一条 `send` 引用了不存在的 bot）。记日志即可。断连一律走 close code。

---

## 7. 能力

每个 bot 报一张表。**五项必报**，三态：

| 键 | 意思 |
|---|---|
| `atAll` | 能不能真的 @全体成员（不是发一串「@全体」文字） |
| `inbound` | 能不能把用户的消息回传给 BN。私聊指令与群链接解析都靠它 |
| `forward` | 合并转发（「聊天记录」卡） |
| `miniAppCard` | 能不能发 QQ 小程序卡（要能向腾讯签 ark） |
| `shareCardLinks` | 群里的分享卡 / 小程序卡消息，你能不能解出里面的链接回传 |

三态：`"supported"` / `"unsupported"` / `"unknown"`。

```jsonc
"capabilities": {
  "atAll": "unsupported",
  "inbound": "supported",
  "forward": "unknown"
}
```

**为什么是三态不是布尔**：你对没见过的平台会真的不知道。BN 面板上「不支持」与
「还不知道」分开显示 —— 前者是结论，后者是「试试看，可能行」。

**为什么由你报、不是 BN 探**：这四家框架（koishi/Satori、AstrBot、NoneBot、OneBot v11）
都自省不了这些。koishi 的 `bot.supports()` 粒度是 Satori 的 **API 方法**（`message.delete`
那类），而 @全体 / 发图 / 合并转发是**消息元素**；适配器遇到不认识的元素**静默丢弃、
不抛错**，连 try/catch 都探不出来。而且能力是「框架 × 平台」的函数 —— 同一个 Telegram
经 koishi 和经 AstrBot 能力可能不同，只有你这一侧知道。

**演进纪律（两个方向对称）**：

- 你**少报**的键，BN 当 `unknown`。
- 你**多报**的键，BN 静默丢掉。所以你可以先报，等 BN 支持了自然就生效。
- 值不是那三个之一，BN 当 `unknown`。

**发文本恒真**，不做成能力项 —— 一个连文本都发不出的 bot 没有接进来的意义。

---

## 8. 入站订阅

`welcome.inbound` 告诉你 BN 要什么：

```jsonc
{ "private": true, "group": "with-links" }
```

- `private: true` —— 私聊消息全要。BN 的指令是**私聊专属**。
- `group: "with-links"` —— 群消息只要**含链接的**。BN 群里没有指令入口，群消息唯一的
  用途是链接解析。判据宽松点没关系（含 `http://` / `https://` 即可），BN 那边还会再筛一遍。
- `group: "none"` —— 群消息一条都不要。

**在你这一侧过滤**：省的是带宽与用户隐私。

**群白名单不下放**。哪些群要解析链接是 BN 的策略，BN 本地过滤 —— 你不用管，
也拿不到那份名单。

---

## 9. 图片：一次性取图口

`send` 里的图片给的是 URL，形如：

```
http://<BN 地址>/bridge/blob/<128 位随机 id>
```

**这个 id 本身就是凭据**：一次性、短 TTL，不用带 token。

URL 里的地址就是**你连进来时用的那个**（BN 从你握手请求的 `Host` 取，反代按 `X-Forwarded-Proto` 定 http/https）——
BN 自己不知道别人从哪儿找得到它，所以它不猜。换句话说：**这条 URL 从你那儿一定通**。

> ### ⚠️ 这个 URL 只保证**你自己**能访问
>
> **要把图交给平台去发，必须先自己下载下来**，再以文件 / base64 / 流的形式交上去。
>
> BN 常跑在 NAS、软路由、家用 NUC 上，外网根本进不来。你把这个 URL 直接甩给
> Telegram Bot API，Telegram 的服务器去拉会失败，而且**是静默失败** —— 用户看到的是
> 一条没有图的消息，日志里什么都没有。
>
> 便宜的地方：koishi 的 `<img src>` 与 AstrBot 的 `Comp.Image.fromURL` 都直接吃 http
> URL，**本地部署时**（桥和 BN 在同一台机器 / 同一个内网）桥连一次内存拷贝都不用做。
> 但那是你和用户共同确认的部署形态，不是协议的承诺。

一次性：取过一次就没了。**别重试同一个 URL**，重试要重新走 `send`。

---

## 10. 断连

BN 主动断连时的 close code（WebSocket 应用私有区 4000–4999）：

| code | 意思 | 该不该重连 |
|---|---|---|
| `4001` | token 被吊销（连上之后才吊销的那种） | ❌ 显示给用户 |
| `4002` | 协议 `major` 对不上 | ❌ 升级插件或 BN |
| `4003` | 帧形状不对 | ❌ 这是插件 bug |
| `4004` | 连上了但 10 秒内没发 `hello` | ❌ 这是插件 bug |
| `4005` | 这条桥接入被删了 / token 被重新生成 | ❌ 显示给用户 |
| `4006` | 同一个 token 又连进来一条，**新的赢** | ❌ 你自己开了两份 |
| `4007` | 桥接模块被关了。配置全留，重开即恢复 | ✅ 退避重连 |

其它情况（网络断、BN 重启、1006 之类）一律 ✅ 退避重连。

---

## 11. 演进纪律

两个方向对称，请照做：

- **收到不认识的 `type` → 记一行日志，忽略。** 别断连、别报错。
  对面比你新时多发一种帧，不该把你打死。
- **收到认识的 `type` 但形状不对 → 那是 bug，不是新帧。** BN 侧的处置是断连 `4003`。
- 对象里多出来的字段忽略掉。

BN 侧就是这么做的，所以你可以放心先发新帧。

---

## 12. 最小实现清单

一个能用的桥，做完这些就够了：

- [ ] 连 `ws://<BN>/bridge`，带 `Authorization: Bearer <token>`
- [ ] 连上立刻发 `hello`（协议版本 + 桥类型 + 全量 bot 名单 + 每个 bot 的能力表）
- [ ] 收 `welcome`，记下 `inbound` 订阅
- [ ] 收 `ping` 回 `pong`
- [ ] 收 `send` → 下载图 → 用 `botId` 指定的 bot 发出去 → 回 `result`
- [ ] bot 名单变了 → 发 `bots` 全量快照
- [ ] 按订阅回传 `inbound`（记得排掉 bot 自己发的）
- [ ] 断线退避重连；`4001` / `4002` / `4003` / `4004` / `4005` / `4006` 不重连
- [ ] 不认识的帧忽略掉，别炸

---

## 附：BN 侧的实现位置

| | |
|---|---|
| wire 类型与常量 | `apps/contract/src/bridge.ts` |
| 帧校验 / 版本判定 / 能力归一 | `apps/server/src/bridge/protocol.ts` |
| WS 端点：鉴权 / 握手 / 心跳 / 回执关联 | `apps/server/src/bridge/server.ts` |
| `inbound` → BN 内部的入站形状 | `apps/server/src/bridge/inbound.ts` |
| 推送 → `send` 帧（矩阵里的桥 adapter） | `apps/server/src/platforms/bridge.ts` |
