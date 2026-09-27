# 1.0 拓展契约 v3

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023。

写拓展的人读这份：清单里能声明什么、ctx 里能用什么、上报长什么样、有哪些规矩、从 v2 怎么过渡。中立接口全集见 [subscription-sources.md](./subscription-sources.md)；上报的数据形状对应 [data-model.md](./data-model.md) 的 `Post` / `LiveDetails`；拓展的推送出口怎么进推送链见 [push.md](./push.md)。

## 一句话

**拓展只从 `@bilibili-notify/extension` 这一扇门拿 BN 的东西**，宿主把它交的东西转成和 B 站同一组中立接口。契约是中立接口族的**子集**：1.0 开 `subscription`、`push`、`devtools` 三口，ctx 加 `subscriptions`（改形状）、`fetchImage`、`storeImage`、`state`、`secrets`、`redact`、`reportProblem` / `resolveProblem`。**拓展只认人、不认订阅**：上报只带 externalId，BN 内部的订阅 id 拓展看不到。

## 版本

| 项 | 1.0 |
| --- | --- |
| 契约版本 | v3 |
| 宿主认的最低版本 | 3 —— v1、v2 的退路删掉（`legacy-v1.ts` 连同过时注释一起删） |
| v2 拓展 | 装不上；数据迁移时照拷，列进升级后的首访页，给一键更新 |
| 以后加口 | 清单里多一个可选键，不抬大版本 |

v3 与 v2 不兼容：第三方拓展重发之前装不上 1.0。桥和 1.0 同批迁到 v3。

## 清单与 contributes

| `contributes` 键 | 宿主登进 | 1.0 |
| --- | --- | --- |
| `subscription` | `subscriptionSources`（键就是拓展 id，不加前缀） | 开 |
| `push` | `pushOutlets` | 开 |
| `devtools` | `devtoolsProviders` | 开。独立入口文件，宿主只在开发版 `import()` 它 |
| `linkResolver` | `linkResolvers` | 暂不开，写抖音拓展时再定 |
| `commands` | `commandProviders` | 暂不开，同上 |
| `aiTools` | `aiToolProviders` | 暂不开，同上 |

- 宿主启用拓展时以拓展 id 登进对应的表（`bilibili` 是保留 id，拓展不许用），撤销把手交给生命周期；停用、卸载即撤，不用重启。
- 注册的口必须是清单开了的口；清单是面板能按哪些钮、能画哪些口的全集。
- 以后开 `linkResolver` 时：清单声明网址模式，拓展只拿到匹配上的那一个链接。
- 核心里这三张表照做、B 站照用，只是先不对拓展开。

## ctx 能用的全部

v2 已有的窄面照留（日志、可回收定时器、`mount`、`onUpgrade`、`inbound`、`publishView`、`statusChanged`、`settings`、面板动作）。⛔ **`bus` 永远不在 ctx 里**：拓展的事件由宿主转进 MessageBus，拓展伪造不了核心事件。v3 的变化：

| 成员 | 变化 | 规矩 |
| --- | --- | --- |
| `fetchImage(url, { headers?, signal? })` | 新增 | 宿主拦内网地址防 SSRF、单张 8MB、按内容嗅探格式、超时；按 sha256 存进图库，交回 `ImageRef`。平台的请求头（Referer、签名）由拓展自己传 |
| `storeImage(bytes, { signal? })` | 新增 | 手里已是字节的图（本地生成的二维码、要自带客户端才抓得到的签名 / TLS 指纹 / POST 图、接口内嵌 base64）走它；同一套格式嗅探与单张 8MB，存进同一图库，交回 `ImageRef`。上报一律只收 `ImageRef`，契约 v3 不再出现 `Uint8Array` |
| `state` | 新增 | `get` / `set` / `delete`，值是 JSON。单键 64KB、总 1MB，超了拒收。宿主原子写到 `runtime/extensions/<id>/state.json`；跟数据代走、不进备份、卸载与全新开始时清。放游标、分页令牌、小索引 |
| `secrets` | 新增 | 放 cookie、token。主密钥加密，存 `secrets/extensions/<id>/`；仅完整备份（普通备份抹掉）；卸载清掉；日志落盘前按真实值脱敏 |
| `subscriptions()` / `onSubscriptionsChanged` | 改形状 | 条目从 `{ id, externalId, enabled }` 改成 `{ externalId, features }`：只列启用中的订阅、不带订阅 id，`features` 是这个人开着的特性；同一人遗留的重复订阅合成一条、`features` 取并集。拓展只上报名单里的人 |
| `reportProblem` / `resolveProblem` | 新增 | 见「问题上报」 |
| `redact(value)` | 新增 | 还没存进 `secrets` 的临时凭据（比如扫码刚拿到的 token）先登记，日志落盘前按值遮掉 |
| `logger` | 改 | 拓展 id 写进日志行的 `name` 字段，不再拼进正文；面板按来源筛；级别键就是拓展 id，可单独调 |
| `registerPushSource` / `PushSourceHandle` / `PushExtensionDef.adapter` | 改名 | `registerPushOutlet` / `PushOutletHandle` / `PushOutletDef.outlet` |
| `publishStatus`（v1 老口）、`LegacyPushExtensionDef` | 删 | 随 v1 退路一起删 |
| 积木 `qrLogin` | 删 | 从没实现；登录走系统账号（`SourceAuth`） |
| `ctx.dataDir` | 不给 | 撤回的草案；拓展没有自己的文件目录 |

ctx 各成员的完整语义与 B 站共用，见 [subscription-sources.md](./subscription-sources.md)「SourceContext」。

## 不许读写文件

- **拓展不读写文件**：写进契约。状态走 `ctx.state`，凭据走 `ctx.secrets`，设置走 `settings`，图走 `fetchImage` / `storeImage`，上报里只交 `ImageRef`。
- **官方市场**发布时做静态检查：打包产物 import 了 `fs`（`fs`、`node:fs`、`fs/promises`）就不收。
- **手动安装**的第三方拓展，安装时警告。
- **真正的强制要等沙箱**：拓展与 BN 同进程，1.0 拦不住。以后用 SES 的 `lockdown` 加每个拓展一个 `Compartment`，先做兼容性小试验再定。

理由：宿主认不得的文件，拓展就得自己保证原子写、自己管备份与回收——宿主落盘的初衷（ADR-0012 决策 14）正是不让拓展背这些。1.0 把它延伸到运行状态。

## 订阅源

### 拓展这一侧交什么

宿主把拓展的订阅源转成一份 `SubscriptionSource`。1.0 的对应关系：

| `SubscriptionSource` 成员 | 拓展这一侧 | 状态 |
| --- | --- | --- |
| `descriptor` | 清单 `contributes.subscription` 直接写 `SourceDescriptor` 的同名字段：`label`、`shortLabel?`、`color?`、`postNoun?`、`creatorNoun?`、`searchPlaceholder?`、`supportedFeatures`、`supportedExtras?`；原来的 `display{ … }` 这一层与 `events` 删掉，宿主的 `SUBSCRIPTION_EVENT_FEATURES` 对照表删掉 | 定了 |
| `searchCreators` | 现有的解析门 `lookup(query, signal)` 改名；`lookupPlaceholder` 改名 `searchPlaceholder`。候选 `{ externalId, name, avatar?: ImageRef, bio?, followers? }`（原 `{ id, avatar: data URL, fans }`），最多 10 个 | 定了（按 id 取人用 `fetchProfile`，没有 `lookupCreator`） |
| `fetchProfile` | 可选；不实现就靠主动报资料 | 宿主适配补齐 |
| `fetchLiveStatus`、`fetchPreview`、`health`、`auth` | 可选 | 形状同中立接口 |

没有「新建 / 启用订阅」钩子：拓展要在订阅变化时做事，一律用 `ctx.onSubscriptionsChanged`，自己对比新旧名单。
| `liveInteractions` | 不开 | 这版不开醒目留言、会员、特别弹幕、特别进场等事件 |

**能声明的特性**：1.0 拓展的 `supportedFeatures` 只能是 `post`、`liveStart`、`liveStreaming`、`liveEnd`；声明了 `liveStreaming` 就必须实现 `fetchLiveStatus`。宿主装载时校验，不合规就拒收并说明原因。

`signal` 的规矩照旧：超时（`TimeoutError`，宿主已回了面板「超时」）与拓展停用 / 收摊（`AbortError`）两种时候中止，手上的请求要接着它停。

### 上报

上报表就是 `Post` / `LiveDetails` 的上报版，**同义同名**；进门转成 `Post` 的收件口在服务端 `extensions/`。和 v2 相比改名的字段：

| v2 | v3 |
| --- | --- |
| `author`（`SubscriptionAuthor`） | `creator`（`SubscriptionCreator`） |
| `video.plays` | `video.views` |
| `video.duration` | `video.durationSec` |
| 直播 `viewers`（此刻在线） | `currentViewers` |
| 直播状态 `live` | `isLive` |
| 资料 `fans` | `followers`；资料补 `bio` |
| 作品 `topics[]` | `topic` |
| 作品上的 `id` / `url` | 挪到 `PostReport` 信封上：`postId` / `url` |
| 表格积木 `count` | `showCount` |

只留一处传输差异，在进门处换掉：

| 差异 | 拓展交 | 宿主换成 |
| --- | --- | --- |
| 时刻 | 毫秒时间戳 | ISO 字符串 |

图没有差异：和 B 站一样，先用 `ctx.fetchImage` / `ctx.storeImage` 存进图库，上报里只交 `ImageRef`。

上报方法与 `SourceContext` 同名同形：

| v2 的把手方法 | v3 | 进核心后 |
| --- | --- | --- |
| `reportPost(externalId, post)` | `reportPost(externalId, PostReport)` | 核心按身份展开成每条订阅一份 `PostEvent` → `post-detected` |
| `reportLiveStart` / `reportLiveEnd` / `reportLiveStatus` | 合成 `reportLive(externalId, LiveSignalReport)`（`start` / `status` / `end`） | 展开成 `LiveSignal`，喂场次引擎 |
| `reportProfile(externalId, profile)` | 不变 | `CreatorProfileReport` |

上报种类（原 `SubscriptionReportKind` 五种）收成 `post` / `live` / `profile`。拓展详情页那个「上报被拒 / 被丢格」的框改名 `reportRejections`，和来源自报的问题分开。

照旧不变的规矩：

- 判新、去重、限流归拓展；BN 报什么收什么。开机第一轮只记基线、别报。
- 按外部 id 报，`sourceKey` 由宿主按 ctx 补（拓展冒充不了别家）；核心按身份查订阅，正常一条，老数据里遗留的重复各分一份，查不到或已停用就丢弃，并兜底再查一次名单。停用的订阅收不到事件与直播状态，资料照样生效。
- 多交一格宿主不认识的，整条拒；认识的选填格值坏了只丢那一格；丢了什么记在日志与拓展详情页。
- 直播 `status` 不触发推送；开播卡 / 下播卡只由事件触发。周期「正在直播」由核心计时、调 `fetchLiveStatus`（见 [subscription-sources.md](./subscription-sources.md)「直播」）。
- 过滤（屏蔽转发 / 文章 / 图集 / 视频、关键词、正则）对拓展作品与 B 站一视同仁：看 `Post` 上有没有，不再只看文字。

### 问题上报

```ts
ctx.reportProblem({ externalId?, code, message, notify?: boolean });
ctx.resolveProblem({ externalId?, code });
```

- 严重度、文案、要不要打扰主人都由拓展定：问题一律进面板问题框，`notify: true` 再私聊主人。
- 核心只守一条底线：同一来源、同一 code 的私聊 60 秒内只发一次。
- 每条问题核心自动记一行日志；只想记日志就用 `ctx.logger`。
- 不填 `externalId` 是来源本身的问题；填了由核心展开到那个人的订阅上（订阅卡上说明为什么收不到），按 code 做键，`resolveProblem` 按 code 清除。code 用 snake（`login_expired`）。

## 推送出口

- `registerPushOutlet(def: PushOutletDef): PushOutletHandle`。一个拓展一个出口。
- **一条连接就是一个借来的 bot**：`platform` 是开放字符串（`OpenPlatformSchema`），从拓展报的 bot 上抄。拓展交的连接候选挂 `boundConnectionId`（原 `listBots` / `ExtensionBotView` / `boundTo`）。连接走 `kind: "extension"`，不往内置平台表里加档。
- 分发键由宿主按拓展 id 填，拓展自报的会被覆盖。
- 接入凭据（如桥的 token）住拓展自己的设置里，不是连接。

## 设置

- 清单里声明 `settings.fields`，`activate` 里交一份 zod，两份对不上当场抛。凭据字段标 `secret: true`（与核心 schema 同一写法），面板打码、备份脱敏、日志脱敏都读这个标记。
- 值存在 `config/settings.json` 的 `extensions.<id>.settings`；开关 `extensions.<id>.enabled` 归宿主。
- **校验不过只停这一个拓展**，面板卡片显示「设置不合法」，BN 照常开机。
- 版本号是内容哈希，对不上回 409。
- 卸载删掉这一段。

## devtools

- 清单 `contributes.devtools` 指向一个独立入口文件，宿主只在开发版 `import()` 它，登进 `devtoolsProviders`。
- 核心 devtools 不认识任何一家来源。桥的假桥与场景搬进 `extensions/bridge/` 自己的开发入口，直接用桥自己的 `contract.ts`，不再在核心手抄协议帧。

## 从 v2 过渡

| 项 | 做法 |
| --- | --- |
| 市场挑版 `pickPerId` | 改成「在当前 BN 装得了的版本里取最高」 |
| 索引规则 | 从「每个 id 一条正式 + 一条预发布」放宽为「每个契约版本各留最新一条」，这样 0.12 仍拿得到 v2 的桥 |
| 桥 | 与 1.0 同批迁到 v3；1.0 alpha 期间 v3 的桥只进预发布档 |
| 已装的 v2 拓展 | 迁移时拷进新数据代；升级后第一次打开面板的询问页列出「因契约版本不收」的拓展，给一键更新；**不在开机时静默替换** |
| 桥协议线上帧 | 1.0 不改（`forward`、`desc`、`picUrl` 等），内部改名只改到桥的 adapter；有快照守卫钉着 |

## 边界

- 拓展底下第三方随便用，我们自己的东西只准从 `@bilibili-notify/extension` 进；反方向核心不 import 拓展。两条都有扫目录的守卫。
- `@bilibili-notify/extension` 只放类型不放实现（拓展会被打成自包含 bundle）；列出来的就是契约的全部，加一格是一次明确的加宽决定。
