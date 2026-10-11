# ADR-0023：1.0 中立命名

- **状态**：2026-09-25 ～ 26 两轮 `/grill-me` 拍板（Q29、Q41、Q43、Q74，命名批 29 条）；2026-09-27 推送 / 订阅 / 配置三路字段名专项审查补了命名规矩 R1–R5 与一批机械改名；2026-09-28 补决策 15（全仓类型名后缀表）。**未施工**。
- **正本**：每一条的「以前叫什么、现在叫什么」对照，以 [docs/1.0/data-model.md](../1.0/data-model.md) 的改名对照为准；本份只写原则、关键条目和不改的范围。
- **同批三份**：[ADR-0021](0021-neutral-core.md) 讲中立核心，[ADR-0022](0022-data-generations-and-migration.md) 讲数据代与迁移，本份讲命名与改名。

## 背景

ADR-0019 定过「中立指结构，不改名」（决策 3、65）。做完 ④–⑦ 回头看，这一条留下了两个问题：
- 核心里的名字仍然带着 B 站口味：`up`、`dynamic`、`guard`、`fans`、`master`、`uname`、`face`。
- 很多字段名当初是随手起的，名字和里面装的东西对不上。

1.0 反正要一次性迁移盘上数据，改名不会额外增加迁移成本。

## 决策

1. **`up`、`author`、`master` 三个词统一叫 `creator`（Q29）**：
   - `author` 从此只指皮肤或拓展的作者；
   - `master` 从此只指「主人」；
   - 皮肤字段 `up.*`、`master.*` 统一改成 `creator.*`；
   - 拓展契约的 `SubscriptionAuthor` 改成 `SubscriptionCreator`。

   被否的备选：把 `up` 拆成三个名字。主人要的是一个词。
   🔗 **2026-09-29**：这一条管核心。`bilibili/` 里 B 站特有的概念用 B 站的叫法，UP 主叫 `up`（`upUid`、`upName`），出口翻成 `creator`；`master` 仍只指主人。词表见 docs/agents/conventions/naming.md。
2. **推送侧与订阅源的命名（Q43、Q41）**：
   - 推送侧：`registerPushOutlet` / `PushOutletHandle` / `PushOutletDef`，`PushOutletRegistry`，目录 `outlets/`；`PushExtensionDef.adapter` 改为 `outlet`；
   - `NotificationSink` 改为 `TargetDispatcher`，免得它和 PushOutlet 都叫「出口」；
   - 订阅侧：`Source` 改名 `SubscriptionSource`；核心里的 `platform` 只指推送或聊天平台，订阅来源的平台名改叫 `sourceLabel`。

   被否的备选：推送侧叫 `PushOutbound`。
   🔗 **2026-09-28 推送侧改回 `PlatformAdapter` 一套**：`PushOutlet` 一族作废；`NotificationSink` → `TargetDispatcher` 与订阅侧那两条不变（ADR-0024 决策 2）。
   🔗 **2026-10-10 订阅侧改回 `Source`**（主人定）：「`Source` 改名 `SubscriptionSource`」这一句作废，接口就叫 `Source`。理由：从它派生的名字（`SourceContext`、`SourceKey`、`SourceDescriptor`、`SourceAuth`、`/api/sources`、`sourceLabel`）早就都不带前缀，只有源头带；规范里也已有「核心里的 `Source` 只指订阅来源」，单说 `Source` 没有歧义。接口本身代码里还没建（3a-28），所以现在改。对拓展可见的 `registerSubscriptionSource` / `SubscriptionSourceDef` / `SubscriptionSourceHandle` 随契约第 3 版（3b）改成 `registerSource` / `SourceDef` / `SourceHandle`，免得同一个方法名中途换两次。代价：代码里别的以 `Source` 结尾的读口（规范要它们改 `…Reader`，还没改完）在那之前容易和它混；「市场源」`MarketplaceSource` 是界面叫法的例外，长期留着。本 ADR 与 ADR-0021 / 0024 / 0012 正文里写的 `SubscriptionSource` 是当时的名字，不回头改。
3. **把平台词清出中立层**：
   - `fans` 整族改成 `followers`；
   - `dynamic` 整族改成 `post`，照 Q29 对 up 的做法，补一条「全改」的总规则；
   - `Work` 系改成 `Post`，去掉 `Neutral*` 前缀；
   - 直播内部的 master 系改成 `creator`；
   - 上舰、SC 出图输入里的 `uname`、`face` 改成 `viewer.name`、`viewer.avatar`，`isAdmin: number` 改成 `isModerator: boolean`；
     🔗 **2026-10-05**（㉓ 开片，主人拍板）：`isModerator` 这一格不要了。它在会员卡上唯一的用处是把主播名换成「房管」两个字，各平台的房管标记也都在聊天消息上、不在会员事件上。词本身没有问题，哪天聊天消息要带这个标记仍用它。
   - 拓展契约里的 `author` 字段改成 `creator`，`viewers` 改成 `currentViewers`。
   🔗 **2026-10-06**（㉔ 开片拷问，主人拍板；改名表与被否的备选见 construction-plan「㉔ 开片」）：
   - **卡种键**：`dynamic` → `post`、`sc` → `superchat`、`guard` → `membership`，`live` / `roastBoard` / `roastSolo` / `wordcloud` 不改；全仓只有一套七个键，预览请求里的 `dyn` 取消。
   - **皮肤的块名、挂点名与字段用同一套词**，随抬皮肤格式版本一次改完；头像与名字的块带上是谁的（`creatorAvatar` / `viewerName`），一块只显示一样东西（直播卡随状态换含义的两块拆成四块）。
   - **卡片样式设置不再按卡种分层**：`cards { enabled, liveCoverImageIds }`。
4. **同一类东西用同一种写法**：
   - 时刻：ISO 字符串，以 `…At` 结尾；
   - 开关：`enabled`；
   - 时长：名字带单位，规矩见决策 9；
   - 缩写：写成 `Ai`、`Api`；
   - 布尔值：带 `is` / `has` / `can` 前缀，例外见决策 11；
   - 过滤：`allow*` 与 `block*` 成对；
   - 服务端：入参类型叫 `*Options`，挂到总线的叫 `bind*`，造对象的叫 `create*`。现存的违规写法列成清单，一并改掉。
   🔗 **2026-09-28**：注入的协作者包 `*Deps` 保留，不并进 `*Options`；各后缀的分工以 docs/agents/conventions/naming.md 为准（决策 15）。
5. **拼写、缩写、名不符实**：
   - 拼音：`formatWan` 并进 `formatCount`，`formatAxisWan` 改名 `formatAxisTick`；
   - `pigeon` / `diligent` 改成 `leastActive` / `mostActive`，提示词和草稿一起改；
   - `subId` 改成 `subscriptionId`，路由改成 `/api/subscriptions`；
   - 名不符实的改掉，例如 `HistoryPatch.patch` 改成 `rowId`，`PickCardBackground` 改成 `PickLiveCover`；
   - 用 0 表示「没有」的时刻，改成不写这个键。
6. **已定的新名之间撞了，这样解开**：
   - `CreatorPostEvent` 改名 `PostRecord`，和同一个文件里的 `LiveSessionRecord` 对称，也避免和 `PostEvent` 撞名；
   - 总线事件名统一成「名词-过去分词」：`subscription-auth-changed`、`live-session-changed`、`live-viewers-changed`；
     🔗 **2026-10-11**（3a-29 B 站半）：`subscription-auth-changed` 已落，载荷 `{ sourceKey, state }`，只有宿主发；它替掉的是 B 站的 `login-status-report` 与 `cookies-refreshed`，`auth-lost` / `auth-restored` 这两个边事件**没换**（主人 10-11 定），仍在总线上，出口随 3a-30 与 3b（见 `docs/1.0/architecture.md` 事件表下的 🔗）。
     🔗 **2026-10-11**（3a-30）：上一条里「私聊主人那一处」已落：`MasterNotifier` 不再听 `auth-lost`，登录失效改由问题表与问题通知器说（`problems-changed` 是新增的事件，载荷 `{ reporter }`，不带 B 站的形状）；直播与统计听 `auth-lost` / `auth-restored` 的出口仍随 3b。
   - 会员体系 `tiers: "custom"`，推送部件叫 `PostPushPart`；
   - 链接卡：配置叫 `linkCards`，接口叫 `LinkResolver`；
   - 错误体统一成 `{ code, message }`；
   - 取订阅身份的函数叫 `subscriptionIdentityOf`；
   - `PushLike`、`SubItemView` 各合成一份，不再按包加前缀区分。
   🔗 **2026-09-28**：`PostRecord` / `LiveSessionRecord` 按后缀表改叫 `PostEntry` / `LiveSessionEntry`（决策 15）；链接卡统一叫「链接预览」，配置叫 `linkPreview`（ADR-0029 决策 1）。
7. **界面文案里的「UP主」由来源给出（Q74）**：见 ADR-0021 决策 35。
8. **施工时守住改名**：每一批改完，全仓 grep 旧名字，结果必须为零；改名对照表里本来就要列出的旧名除外。新写或重写的代码直接用新名字，收尾期只清扫没被动到的旧名。

### 09-27 字段名专项审查补的命名规矩

9. **时长后缀（R1）**：`Ms` / `Sec` 用缩写，`Minutes` / `Hours` / `Days` 写全（`cooldownSec`、`streamingIntervalHours`、`loginCheckIntervalMinutes`、`retentionDays`）。不用 `Min`，因为会和 `minScPrice` 这类「最小值」前缀撞。cron 字符串的字段以 `…Cron` 结尾。没带单位的名字要补上：`fansCron` 改成核心的 `profileRefreshCron`，迁移时原值照搬。
10. **枚举值的大小写（R2）**：事件与状态类的值用 kebab（`grace-expired`、`logged-out`）；错误码与问题码用 snake（`invalid_profile`、`follow_failed`）；特性键保持 camel（`liveStart`）。「此刻没在播」统一叫 `offline`，`end` 只指「下播」这个事件。
    🔗 **2026-09-28**：应用内更新的 `reason` 是失败原因，也改成 snake（ADR-0026 决策 3）。
11. **操作结果的 `ok` 是布尔前缀规矩的例外（R3）**：全仓 537 处、76 个文件的 `{ ok }` 保留，它意思没有歧义，改名换不来什么。失败原因只用 `code` + `message`，`reason` / `err` / `why` 不再出现；上游平台的错误码放 `upstreamCode`，不占 `code`。

    被否的备选：`isOk`（生态里几乎没人这么写）、`success`（名词，照规矩同样要前缀）、字符串 `status`（`status` 在仓里已经太多意思）、看有没有错误字段（类型收窄不如 `r.ok` 清楚）、HTTP 接口不要 `ok` 改看状态码（最地道，但有些接口故意用 200 带业务失败，要逐个分辨，537 处不值得）。
    🔗 **2026-09-28**：「`reason` / `err` / `why` 不再出现」只管失败原因，事件原因与描述性字段不在此列（ADR-0026 决策 2）。
12. **历史行的推送种类那一格叫 `feature`（R4）**：值就是特性键；`/api/history?feature=`、按天计数的键、测试推送的种类都跟着改，测试推送不再用 `dyn` / `sc` / `guard` 那一套。
    - 理由：`kind` 在仓里已经是订阅、推送载荷、连接好几处的判别键。
13. **`defaults` 只表示「按订阅覆盖时的回退层」（R5）**：订阅上能单独覆盖的设置，全局那份放 `core.defaults`（文案模板、词云停用词、免打扰时段、人格预设 `presetId`……）；订阅覆盖不了的一律挪出去（AI 实例桶、搜索、聊天进 `core.ai`，出厂文案账本进 `core.templatesSeen`）；链接卡的「默认行」改名 `linkCards.base`。形状见 [docs/1.0/data-model.md](../1.0/data-model.md) 的「配置」一节。
    - 理由：`defaults` 原先一词三义（回退层、链接卡默认行、出厂文案账本），而且挂着不少根本没有订阅覆盖版本的东西。
    🔗 **2026-09-28**：链接卡改名链接预览，配置摊平成 `linkPreview { enabled, replyForm, byTarget }`，没有 `base` 这一层（ADR-0029 决策 1）。
    🔗 **2026-10-10**（3a-38，主人定范围）：出厂文案账本与 AI 整段已上提到核心设置顶层（`templatesSeen`、`ai`），`defaults` 里不再有这两块，键名一个没改。人格预设 `defaults.ai.presetId` 这一格这一片没造：人格指针与人格库当同一个对象读写，单拆指针要改读者的入参与 AI 页的草稿，所以指针 `activePreset` 暂随整段留在顶层 `ai`，`presetId` 随 AI 子键改名那一片造。
14. **三路审查的机械改名整批采纳**：推送（如订阅顶层 `extras` → `extraTargets`、`retryOf` → `repushOf`、`testStatus` → `probeStatus`）、订阅（如 `reportProblems` 这一族 → `reportRejections`，把「上报被拒」和来源自报的问题分开）、配置（如全局 `roastSchedule` → `rankingReport`、`app` 拆成 `logging` / `history` / `timezone`）。逐条对照以 [docs/1.0/data-model.md](../1.0/data-model.md) 改名对照里订阅、推送、配置三张表为准。
    - ⚠️ 两个机械替换会改错的坑：面板在播列表的 `viewers` 装的是累计观看（还是排好版的字符串），要改成 `totalViewers: number`，**不是** `currentViewers`；B 站接口的数字错误码原先占着 `code`，统一错误体以后挪到 `upstreamCode`。
    🔗 **2026-09-28**：`probeStatus` 装的是对象，按后缀表改叫 `probeState`，三态取值放在里面的 `status`（决策 15）。
    🔗 **2026-10-09 `reportRejections` 这一族改叫 `reportDiscrepancies`**：主人指出「被拒」只说得上三种结果里的一种（整条拒），丢了几格与这一轮没推都不是；`Discrepancy`（出入）指「报上来的和 BN 实际处理的不一样」，三种都盖得住。逐条对照见 data-model.md 改名对照的订阅表；词表加了 `Discrepancy` 一行（[naming.md](../agents/conventions/naming.md)）。

### 09-28 补的命名规矩

15. **类型名的后缀一个概念只用一个词，表放在 [docs/agents/conventions/naming.md](../agents/conventions/naming.md)**：起新名、改名先对表；表里没有的概念先加一行再用。表是活规范，可以直接改，但加行、改行要主人拍板。守卫扫核心与 contract 的类型名，用了「不再用」那一列的判红。按表改名的逐条对照进 docs/1.0 的改名对照。
    - 理由：同一个概念在仓里有两三种写法（`Result` / `Outcome`、`View` / `DTO`、`Entry` / `Record` / `Row`、`Options` / `Params` / `Args` / `Config`），读名字认不出装的是什么。表放在 ADR 里只能追加 🔗，越改越难读；放在活文档里，读到的永远是现在的规矩。
    - 被否的备选：表写进本份 ADR；按包各定各的叫法。
    🔗 **2026-09-29 扩大范围**：表管我们写的全部代码（核心、内置集成含 `bilibili/`、面板、官方拓展），守卫随之扫 `packages/`、`apps/`、`extensions/`；原先豁免的「照 B 站接口起名的类型」收回，只有第三方库的名字与外部协议定死的字段名不管。

## 明确不改

- 产品名、包作用域 `@bilibili-notify/*`。
- `bilibili/` 里贴着 B 站接口的原始字段名，以及 `uid`、`roomId`。
- `bilibili/` 内部名实相符的名字，比如 `biliLiveCardInput`。（原先这里列的 `BiliSubscription` 等，已被 ADR-0021 决策 14 的身份摊平取代：订阅不再分 B 站支。）
- **日志行格式**：日志跨代共享，冻住的桌面壳也把日志目录写死了。改了名字得不到好处，回退后还会显示错乱。
- **通用 webhook 的 JSON**：读它的是用户自己写的接收端，没法通知他们，也没法协商版本，所以永远不改。
- **1.0 不改桥协议的线上帧**（`forward`、`desc`、`picUrl` 等）：已经发布的 koishi 和 AstrBot 插件在读，而握手只比对主版本号。内部改名只改到桥的 adapter 为止。真要改就分两步：先发一版插件，同时认新旧两种字段；等大家都升级了，BN 再切过去。
    🔗 **2026-09-27 改期**：alpha 期间不改；1.0.0 之前按上面的两步改完。插件发给 BN 的入站字段反过来走：BN 先同时认新旧，插件再改发新的（ADR-0029 决策 2）。改成什么名字列在 docs/1.0 的施工计划。

## 取代与修订的旧条款

落稿时在每条旧条款的原文下挂一个 🔗，指到本份。

| 旧条款 | 现在 | 本份 |
|---|---|---|
| ADR-0019 决策 3「BN 内部一处都不改名」、决策 65「中立指结构，不改名」 | 推翻：结构和名字都要中立（特性键与皮肤字段见 ADR-0021 决策 30、31） | 1–6 |
| ADR-0011 决策 11、14（`PlatformAdapter` 拆成 `Connector` + `PlatformDialect`） | 修订：接口名改叫 `PushOutlet`，拆出来的两半的新名字施工时定 | 2 |
| ADR-0012 决策 45（一条拓展连接就是一个 bot） | 规则不变；契约里的 `PushExtensionDef.adapter` 等名字随推送侧一起改 | 2 |
| ADR-0006 决策 9（真相住在 `linkParsing`） | 修订：配置改名 `linkCards` | 6 |
| 拷问中途：N1 的 `Post.author`、N2 的 `author.*` | 改为 `creator`（Q29） | 1 |
| 拷问中途：命名批定的 `SubscriptionRuntimeStore` | 改为 `SubscriptionStateStore`（见 ADR-0022 决策 13） | 14 |
| 拷问中途：时长「名字带单位 `Ms` / `Sec`」、`profileRefreshInterval` | 细化为决策 9，`profileRefreshCron` | 9 |

## 以后再说

- **施工时定**：`PlatformDialect`、`Connector` 的新名字；`cookieEncryptionKey` 的新名字；WS 频道 `push-events`、`countsAsDelivery`、`muted` / `allowAtAll` 的新名字。
