# 订阅参考

订阅的两支、两种键、资料与头像、订阅源拓展（清单 / 契约 / 解析门 / 上报）。这份是地图与规矩。

**「为什么这么定」在 [ADR-0019](../adr/0019-subscription-source-opening.md)**（下文括号里的「决策 N」都指它）。推送链本身见 [push.md](./push.md)；总线事件的逐条语义见 [events.md](./events.md)，这里只点名、不重抄。拓展的地基（ctx、装载、一扇门）见 [architecture.md](./architecture.md)「拓展」一节。

## 一句话

**B 站也只是一个来源**（决策 1 / 65）：订阅记录、推不推、推给谁、卡片与历史全归 BN；拓展只管「和那个平台打交道」—— 把主人粘的东西解析成候选、判新、报事件与资料。拓展**写不了订阅**，也不知道推给谁。

## 两支订阅

schema 在 `packages/internal/src/schema/subscriptions.ts`，联合类型 `Subscription = BiliSubscription | ExtensionSubscription`。

| | B 站 `BiliSubscription` | 拓展 `ExtensionSubscription` |
|---|---|---|
| `kind` | `"bilibili"` —— 只活在内存与线上，盘上没有这一格，缺了就是 B 站 | `"extension"` |
| 身份 | `uid`（纯数字串） | `extensionId` + `externalId`（拓展给的不透明串，1–256 字，BN 从不解读） |
| 独有 | `specialUsers` | —— |
| 共有 | `id` / `name` / `enabled` / `groups` / `notes` / `routing` / `extras` / `overrides` / `roastSchedule`（拓展那支是 ADR-0020 决策 14 加的，老文件缺这一格读进来补出厂默认） | 同左 |
| 盘上 | `<dataDir>/state/subscriptions.json` | `<dataDir>/state/extension-subscriptions.json` |

- **拓展那支连 `uid` 这个键都没有**（不写 `uid?: never`）：键不在，编译器才会把每一处直接读 `sub.uid` 的地方列出来逐个分流，「遍历订阅去 B 站拉资料」不会拿别的平台的 id 去问 B 站。
- 解析是 `SubscriptionSchema` **按 `kind` 分派**（不用 `z.union` / `discriminatedUnion`：B 站那支 `kind` 可缺、前面还挂着老数据迁移的 preprocess；挨个试会把一行坏 B 站订阅报成两份错）。
- **分流的惯用法**：`isBiliSubscription` / `isExtensionSubscription`（`packages/internal/src/constants.ts`，零依赖，面板经 `/constants` 用同一份）。判据是 `kind !== "extension"`，与盘上「缺了就是 B 站」同口径，两者互斥且覆盖全部。读任何一支独有的字段之前先收窄；泛型，订阅本体、wire DTO、折叠后的视图都能收。

### 内存一份，盘上两个文件（决策 47 / 48）

- `SubscriptionStore`（`packages/subscription`）只握**一份联合列表**，`subscription-changed` 的 diff 两支都发。`findById` 两支都找；`findByUid` 只找 B 站（外部 id 恰好是同一串数字也找不到）。
- `ConfigStore`（`apps/server/src/config/store.ts`）的 `writeSubscriptions` 按 `kind` 拆开、**只写真变了的那个文件**（改 B 站订阅不会凭空建出拓展那个文件）。B 站行落盘剥掉 `kind`（`toDiskBiliRow`）—— 应用内更新退回旧载荷时，它读到的就是它自己写的形状。旧载荷不认拓展那个文件，照常开机；再升回来拓展订阅都在。
- 两个文件**各用各的那支校验**，任何一行坏了整个拒、开机报错（`parseSubscriptionFile`）。不跳过坏行：跳过的话下次写回，那几行就永久没了。
- **身份不许改**（`assertSubscriptionIdentityUnchanged`，决策 50）：换 uid / 外部 id / 平台就是另一个人，而资料缓存、历史、头像文件都挂在订阅 `id` 上。要换人就删了重加。
- **备份**（`apps/server/src/backup/`）：拓展订阅单独一节 `extensionSubscriptions`，**不抬 `schemaVersion`** —— 旧版 BN 跳过不认识的这一节照常恢复；混进 `subscriptions` 的话旧版那几行过不了 uid 校验，整份恢复被拒。导出与 `subscriptions` 同一个勾选；恢复时两支各算各的，没有这一节的备份 overwrite 也碰不到现有的拓展订阅。资料缓存与头像文件都不进备份。

## 两种键（决策 50）

| 键 | 回答 | 用在 |
|---|---|---|
| **身份**：B 站 `uid` / 拓展 `(extensionId, externalId)` | 这是谁 | 判重（新建拓展订阅撞了回 409 `duplicate_subscription`）、把拓展的上报对到订阅上、历史行找回订阅、颜色 |
| **运行期键**：订阅自己的 `id`（uuid） | 是哪一条 | 推送链（`broadcastToFeature`）、历史行的 `subscriptionId`、资料缓存、头像文件、拓展在播表、女仆查订阅的视图、增删改接口、备份的合并计划 |

- 🔴 **身份别拼字符串当键。** 外部 id 是拓展给的不透明串，什么字符都可能有：拼就得选分隔符、做转义，当文件名、进 URL 还得再转义一次。按身份查一律**两层 map**（拓展 id → 外部 id），样板是 `runtime/target-scope.ts` 与 `apps/web/src/pages/up/subscription-lookup.ts`。拼成 `extensionId:externalId` 的只有两处、都只给人看：取色（`packages/internal` 的 `upColor` / `extensionColorSeed`，面板与服务端出图共用一份，ADR-0020 决策 15）与推送层的日志标签（`subscriptionLabel`）。
- **绝不跨支**：外部 id 恰好等于某个 B 站 uid，也是另一个平台上的另一个人。
- 同一个人配两条订阅时**各推各的路由**；按身份找「第一条」时先出现的那条说了算（B 站引擎那条边 `subscriptionIdOfUid` 同此）。

### 哪些地方故意只认 B 站

都写成 `.filter(isBiliSubscription)` 或先收窄再跳过，旁边有一句为什么：

- **B 站引擎的订阅视图**：`engines.ts` 的 `buildDynamicSubsView` / `buildLiveSubsView`、op 翻译 `subscriptionOpsToDynamic` / `subscriptionOpsToLive`、`getModuleStatus` 的「直播监听」那一格。拓展订阅的轮询是拓展自己做的。
- **关注**：`runtime/follow-sync.ts`、新建时的关注与 B 站资料种子（`routes/subs.ts` 的 `followUp` / `seedCachedProfile`）、查 UID / 搜名字（`/api/subs/lookup`、`/api/subs/search`）。
- **粉丝轮询**：`runtime/fans-poller.ts` 只问 B 站订阅（B 站资料与粉丝曲线的来源）。它发的首页粉丝面板快照两支都有：拓展订阅那一行不问任何人，从统计写下的粉丝时序算（ADR-0020 决策 8，只列启用着、有时序的）。
- **统计 / 锐评**：`routes/stats.ts`、`stats/roast-*.ts`、`runtime/roast-scheduler.ts`，面板的 Stats / Cards 页。⚠️ 这是**今天的现状、不是定案**：决策 63 定了统计页 / 粉丝曲线 / 锐评第一版就管拓展订阅（施工在 ④′，[ADR-0020](../adr/0020-stats-cover-extension-subscriptions.md)），卡片页的按 UP 预览放到 ⑤ 定。**采集已经两支都记**：`stats/recorder.ts` 挂着 B 站与拓展两个适配（`bili-source.ts` / `extension-source.ts`），拓展订阅的作品、场次、粉丝、「在记」都按订阅 id 落盘。**`GET /api/stats/overview` 也两支都列了**：行以订阅 id 为键、带 `uid` 或拓展 id + 外部 id，拓展行「那天有没有记录」只看它自己的「在记」（不借 B 站的粉丝采样），在播取引擎的 `extensionLiveSession`（场次模块）、当前粉丝取资料缓存（停用的退回样本末值）。**统计页也两支都画了**（S5）：行按订阅 id 选中 / 聚焦，颜色走 `upColor`、名字走 `displayName`，拓展行带平台徽章，单人页头拓展写「平台名 外部 id」；CSV 的身份列是「平台 / UID / 外部 ID」（外部 id 不塞进 UID）。**锐评也两支都管了**（S6，决策 12 / 14 / 15 / 18）：一张榜混着比（「至少 2 位」数两支加起来的人头），提示词不写死「B 站」、数据表多一列「平台」（B 站写「B 站」，拓展写引擎 `extensionPlatformLabel` 现取的清单平台名，取不到写拓展 id）；名字链在 `stats/roast-subject.ts`（B 站：资料名 → `UID xxx`；拓展：资料名 → 别名 → 外部 id）。结果、单人锐评、推送请求、路由参数（`/roast/:subscriptionId`、`/roast/run-now/:subscriptionId`，面板编码进路径）、草稿里的 UP **一律是订阅 id**；盘上 `state/roast-drafts.json` 里升级前按 uid 记的草稿，读盘时按 uid 找回 B 站订阅翻译过来，对不上的丢掉、记 debug。单人定时锐评按订阅 id 排、跑、发，`PATCH /api/subs/:id` 的审批闸两支都拦。出卡（`stats/roast-deliver.ts` 的 `makeUpMeta`）：颜色走 `upColor`（同面板），拓展头像读存下的头像文件转 data URL（资料里那个面板相对地址截图加载不到，同 ADR-0019 决策 68 的坑）。
- devtools 场景挑订阅（`index.ts` 里那段 `subs`）—— 它造的是 B 站事件。
- 决策 64 列的**只属于 B 站**：群里链接自动出卡、私聊指令按 uid 订阅、弹幕那一族（SC / 上舰 / 特别关注 / 词云 / 总结）。

反过来，**遍历所有订阅**的地方两支都要处理（决策 47 把列表合成一份就是为了它们不静默漏掉拓展订阅）：删推送目标时清引用、目标别名改写、开机清资料缓存（`pruneOrphanSubRuntime`）与扫孤儿头像（`subAvatarStore.sweep`）、删皮肤 / 卡片背景前查「还有人在用」、备份、健康页。

## 资料与头像

**资料缓存**是 `SubRuntimeStore`（`apps/server/src/runtime/sub-runtime-store.ts`，`<dataDir>/state/sub-runtime.json`，按订阅 id）里的 `cachedProfile { name, avatar, sign, fans?, lastRefreshedAt }`。它**不是配置**：写它不发 `config-changed`（那一档会重建路由表、通知拓展、让引擎 reconcile）。`GET /api/subs` 在 `toDTO` 里把它 join 进 DTO。

| | B 站 | 拓展 |
|---|---|---|
| 新建时 | `seedCachedProfile` 问一次 user card | 面板把解析门里挑中的候选（`{ id, name, avatar?, fans? }`）随 `POST /api/subs` 交进来，`seedExtensionProfile` 种资料、头像写成文件 |
| 之后 | `FansPoller` 每 tick 写 fans、按需冷刷 name / avatar | **只认「报资料更新」**（`reportProfile`，见下）。事件里带的作者只上卡、不改资料（决策 54） |
| `avatar` 存的是 | B 站 CDN 链接 | 同源相对地址 `/api/subs/<id>/avatar?v=<摘要>`，没有就是空串 |
| `fans` | 总有 | 可缺 —— 缺了写 0 就是在面板上印一句「0 粉丝」的假话 |

**拓展资料的落盘**：`subscription-reported`（`kind === "profile"`）→ `runtime/reported-profiles.ts` 的 `bindReportedProfiles`：给了哪格改哪格；停用的订阅照样更新；订阅刚删时报上来的不再种；排一条队（两条交错读改写会互相冲掉）；面板看得见的名字 / 头像 / 粉丝**真变了**才发 `subscription-profiles-changed`（250ms 窗口合并）。

**头像文件**（`runtime/sub-avatar-store.ts`，决策 49）：`<dataDir>/avatars/<订阅 id>.<png|jpeg|webp>`。

- 只收位图、按魔数认格式（`sniffImageFormat`），**不收 SVG** —— 同源地址上的 SVG 被直接打开时会跑脚本；约 96 KiB 封顶（候选的 data URL 是 128 KiB 字，`SUBSCRIPTION_AVATAR_MAX_BYTES` 按它倒推，报上来收下了、存的时候却被拒是最难查的那种）。
- 内容摘要不同才覆盖，地址的 `?v=` 随之变，所以 `GET /api/subs/:id/avatar` 可以让浏览器长缓存（面板鉴权、`nosniff`）。
- 删订阅时 `bindSubAvatarCleanup` 听 `subscription-changed` 的 remove 删文件（删的路不止一条，最后都汇到那里）；开机 `sweep` 扫孤儿。
- 出卡时这个相对地址截图加载不到 —— `runtime/extension-push-common.ts` 的 `extensionCardAuthor` 读文件的**字节**转 data URL（事件带了作者头像就用事件的，哪儿都没有给透明占位，决策 54 / 68）。同一个文件里的 `extensionSubscriptionName` 定卡上作者名与模板 `{name}`：事件里的作者名 → 资料名 → 主人起的别名（`name`）→ 外部 id；面板上标「备注」的 `notes` 是自由文字，**不当名字用**（决策 77）。

**显示名与颜色**（`apps/web/src/utils/up-display.ts`）：

- `displayName`：资料名 → B 站「UID xxx」/ 拓展「主人起的名字 → 外部 id」。
- `subscriptionColor`：**颜色跟着人走** —— B 站按 uid，拓展按 `extensionId:externalId`（带冒号与拓展名，永远不等于纯数字 uid，不会和 B 站 UP 撞色）；删了再加颜色不变。历史行 `historyRowColor` 同一条规矩。
- 历史行的身份兜底 `historyRowIdentity`：「UID xxx」/「平台名 · 外部 id」，平台名取不到（拓展卸载了）写拓展 id。
- 平台名与徽章：`apps/web/src/pages/up/subscription-source.ts` 的 `subscriptionPlatformOf`，从清单的 `display` 来。

## 订阅源拓展

### 清单 `contributes.subscription`（决策 5 / 16 / 51）

schema 在 `packages/internal/src/schema/extension-manifest.ts`，只有清单 v2 开得了。样板是 `extensions/fake-source/`（开发用假源：解析门现编候选，页上的动作按钮造五种上报，外加坏图、多一格两种反例）。

- `display`：`label`（全名，平台选择那一排）、`shortLabel`（≤8 字，卡上的方章）、`color`（只收 hex）、`postNoun?`（「作品」；不给叫「动态」）、`lookupPlaceholder?`（新建订阅时输入框那句提示）。
- `events`：`post` / `liveStart` / `liveEnd` 的非空、不重复子集 —— **这就是能力声明**。配置弹层只列它对应的特性（`SUBSCRIPTION_EVENT_FEATURES`：`post → dynamic`、`liveStart → live`、`liveEnd → liveEnd`；面板 `featuresForEvents` / `visibleFeaturesOf`），报了没声明的种类整条拒。
- `cardSkin?`：自带皮肤目录（决策 13 / 14，⑤ 施工）。
- 面板拿到的是 `manifestSubscriptionView`（`apps/server/src/extensions/context.ts`）—— **只从清单来、不问代码**，所以拓展停着也画得出订阅是哪个平台的（决策 41）。

### 契约档位与契约小号（决策 18 / 59）

- `EXTENSION_API_RANGE = { min: 1, current: 2, revision: 0 }`。清单的 `apiVersion` 是要的档位（落在 `[min, current]` 才收），`apiRevision` 是要的小号（缺省 0）；`apiVersionAccepted` 判「装得了吗」，装包（`extensions/install.ts`）、发现（`discover.ts`）、市场（`marketplace.ts`）用同一把尺子。宿主**先单读 `apiVersion`，再读小号，再按那一档的格式校验**，旧宿主说的是「版本不合」而不是「清单读不了」。
- 🔴 **拓展能用的东西变多**（事件表加一格、ctx 多一个方法、多一种积木、清单多一格）且**对应的 BN 已经发过版** → `revision` 加一。为别的原因发版不动它；**只增不归零**（抬档位也不归零）。不兼容的改动 = 抬 `min` 并删掉对应的退路。v2 还没发版，里面现有的一切都算 0 号。
- 守卫 `packages/internal/src/schema/extension-contract-shape.test.ts`：清单 v2、解析门候选、视图、五种上报这几份 zod 转成 JSON Schema 算摘要，与 `PINNED_REVISION` **成对**钉住，形状一动就红，报错里写着该怎么改（发过版 → 抬小号 + 更新摘要与 `PINNED_REVISION`；没发版 → 只更新摘要；新摘要照 Received 填）。以后加一份拓展交给 BN 的 schema，就往它的 `CONTRACT` 表里加一行。
- ⚠️ 守卫**看不见的**：`refine` / `superRefine` 里的规矩、图的格式与单张字节上限（在 `z.custom` 的判定函数里）、整条上报的图总量上限（在 `checkSubscriptionReport` 里）、ctx 多一个方法（纯 TS）。放宽这些同样要抬小号，自己想。
- `packages/extension` 里给拓展看的 TS 类型是这些 zod 的**手写镜像**（拓展进不来 internal），由 `apps/server/src/extensions/subscription-shape-pin.ts` 双向严格相等地钉住。

### 注册、解析门、新建

- **注册**：`ctx.registerSubscriptionSource({ lookup })` → `SubscriptionSourceHandle`（契约在 `packages/extension/src/index.ts`）。只 v2、且清单开了这一口；一个拓展只注册一个（一个拓展就是一个平台，决策 9）；收摊时摘掉。**没有单开一张注册表**：订阅源记在各拓展的 ctx 上，装载器的 `LoadedExtensions.lookup(id, q)` 转给在跑的那一个；「哪些拓展是订阅源」一律从清单读（`/api/ext` 每行的 `subscription`）。
- **解析门** `GET /api/ext/:id/lookup?q=`（`apps/server/src/routes/extensions.ts`，决策 11 / 52）：只在 `/api/*` 下、吃面板鉴权（拓展拿主人的 cookie 去平台查人）。候选 `{ id, name, avatar?, fans? }` 最多 20 条、`id` 不重复、头像只收位图 data URL（`SubscriptionCandidatesSchema`，`schema/extension-subscription.ts`），宿主先核形状。状态码各有原话：没在跑 / 不是订阅源 404；15 秒超时 504（拓展收到的 `signal` 同时中止）；拓展抛了 502「拓展查询出错」；候选不合规矩 502「交回的候选不合规矩」并点名原因。查询**可以并发**，不设「在跑时再按回 409」。
- **新建**：面板只在至少一个订阅源**在跑**时出平台选择（`runningSubscriptionSources`），否则与只有 B 站时一模一样。`POST /api/subs` 带 `kind: "extension"` 且 id 是新的 → `createExtensionSubscription`：`extensionId` 得是**装着的** v2 订阅源（不要求在跑，`subscriptionSourceRefusal`），同拓展同外部 id 已有就 409，建完拿候选种资料与头像。已有的拓展订阅整份 POST 回来改照常走通用那条路，身份几格改不动。
- **拓展读自己名下的订阅**：`handle.subscriptions()` 现读，只有 `{ id, externalId, enabled }`，停用的也给、跳不跳过它自己定；`onSubscriptionsChanged` 挂在 `config-changed "subscriptions"` 上（`index.ts`）。别缓存 —— 变更通知是拿来做动作的（补新订阅的基线），不是拿来刷缓存的。

### 拓展停了之后（决策 10 / 61）

订阅**保留**，只有主人手删才删：面板置灰、写「××拓展没在跑」（`pages/up/UpCard.tsx`；没装时拿不到名字就写拓展 id），卸载确认框写「有 N 条订阅会保留（暂停）」（`pages/ExtensionDetail.tsx`）。不轮询不推送（轮询本来就是拓展做的）；ctx 收摊那一刻发 `extension-stopped`，之后它的上报一概拒，在播表清掉它名下的；**已经排在串行闸里的作品**到点时再核一次「拓展还在跑吗」（`extensionSubscriptionPushable`，出卡、点评之后发送之前也核），停了就不推、不补（决策 61）。等待中的断流接续与下播卡同样作废，随拓展直播那一片落地。开回来自动恢复，在播靠直播状态上报接上。

## 上报（决策 4 / 7 / 53–62）

五个方法：三种**事件** `reportPost` / `reportLiveStart` / `reportLiveEnd`（触发推送），两种**不触发推送** `reportLiveStatus` / `reportProfile`。字段表是 `packages/internal/src/schema/subscription-report.ts`。

一条上报在 ctx（`apps/server/src/extensions/context.ts` 的 `receiveReport`）里走：核外部 id（`checkReportedExternalId`）→ 核种类（`undeclaredReportReason`：事件要清单声明；直播状态要声明了开播或下播之一；资料总收）→ 核形状（`checkSubscriptionReport`）→ 按 `(这个拓展, 外部 id)` 找它名下的订阅 → 按开关筛 → `onSubscriptionReport` → 总线 `subscription-reported`（载荷 `SubscriptionReportDelivery{ extensionId, externalId, subscriptionIds, report }`）。**交到总线那一下就 resolve**，不等出卡与推送（决策 62）。「是哪个拓展在报」由宿主从 ctx 认，拓展只能报自己名下的。

| 情况 | 结果 |
|---|---|
| 有 BN 不认识的字段 | **整条拒** —— 只可能是拓展把要的小号写低了 |
| 必填缺了 / 坏了 | **整条拒** |
| 认识的选填格值坏了（图解不开 / 超大小、数为负、超长） | **只丢那一格**，其余照收 |
| 作品正文（`text`，10000 字）/ 视频标题（`video.title`，256 字）超长 | **截到上限收下**（截在字符边界上，不劈开 emoji），问题框记一句「已截断」—— 屏蔽、出卡、点评看的都是截下来的那段（决策 59 的 09-24 🔗） |
| 报了清单没声明的种类 | 整条拒 |
| 外部 id 不是 1–256 字的字符串 | 整条拒 |
| 外部 id 不在名下（多半是订阅刚删） | 忽略、正常 resolve，只记 debug |
| 名下订阅都停用了 | 事件与直播状态不往下发，也不进首页在播；资料照样生效 |

- 拒 = 拓展那头 reject 一个带原因的 `Error`（拓展不接这个 Promise 也不会变成 unhandledRejection）。拒与丢格都只从 ctx 里**唯一**的出口 `reportProblem` 走：日志一行 + `onSubscriptionReportProblem` → `extensions/report-problems.ts`（每个拓展最近 20 条、只在内存、卸载清空）→ `ExtensionDTO.reportProblems` → 拓展详情页「上报问题」框（决策 60）。不私聊主人 —— 系统性的 bug 就是每条作品一条私聊。
- 施工定下的数：时刻一律**毫秒**、不早于 2000 年（交成秒当场报出来）；图一律交 `Uint8Array`、按魔数认格式、收下的是 BN 自己拷的一份；作品图 png / jpeg / webp / gif，单张 ≤ 8 MiB、每条 ≤ 30 张、整条合计 ≤ 64 MiB；头像只收 png / jpeg / webp；作品的话题（`topics`，话题名、不带 `#`，两头的 `#` 与空白先剥掉）每个 1–64 字、最多 20 个，坏的只丢那一项，重复的去掉（决策 55 的 09-24 🔗）。
- 🔴 **判新归拓展，BN 不兜底**（决策 53）：不判新、不按作品 id 去重、不限流，报什么收什么；开机第一轮只记基线不报是拓展自己的事（假源照这条写）。
- 今天的消费者：
  - 作品推送（`runtime/extension-posts.ts` 的 `bindExtensionPosts`，收 `post`）：每条订阅一道串行闸 → 再核订阅在、启用、拓展在跑 → 动态总开关 → 只按文字过滤（`filterByText`，正文 + 视频标题）→ `extensionPostWork`（`runtime/extension-post-work.ts`）翻成中立作品 → 与 B 站动态同一份的 `deliverWork`。推出去之后落历史的拓展行、可以人工重推；途中意外抛错只记日志不重试（决策 77）。细节见 [push.md](./push.md) ①。
  - 资料落盘（`runtime/reported-profiles.ts`，收 `profile`）。
  - 拓展在播表（`runtime/extension-live.ts`，收 `liveStart` / `liveEnd` / `liveStatus`，表变了发 `extension-live-changed`，首页经 `/api/live/listening` 合进来）。开播 / 下播 / 周期「正在直播」卡、重启补推、断流接续由 `runtime/extension-live-push.ts` 的 `bindExtensionLivePush` 推（决策 57 / 58 / 61 / 67）：每条订阅一套状态与一道串行闸，最新状态取在播表；周期推送只在上次推送后收到过新状态时才推，否则记一条「跳过一轮」进上报问题框；拓展停了 / 订阅停用 / 两个直播特性都关，计时器与等待中的下播卡作废、不补推。
- 相关事件 `subscription-reported` / `subscription-profiles-changed` / `extension-live-changed` / `extension-stopped` / `extension-report-problems-changed` 的语义见 [events.md](./events.md)。🔴 拓展的在播**不发 `live-state-changed`**，资料变了**不发 `config-changed "subscriptions"`**。

## 高级规则与女仆查订阅（决策 64）

- **高级规则「按 UP 定制」**：`apps/web/src/pages/rules/sections.tsx` 的 `perUpSectionsFor(sub, features)`。B 站全露；拓展按源报得出的特性露 —— 过滤（只露关键词 / 正则 / 白名单，`FILTER_TEXT_KEYS`；四个类型开关对拓展作品一律不看，决策 70）与动态消息（报作品才露）、直播消息（报开播或下播才露）、消息版式与 AI 人格（都露）；「直播阈值」换成「推送时段」（免扰总露，报直播时再加推送频率 / 重启补推 / 断流接续）。不露：动态图集（决策 72）、直播总结、上舰提示、特别关注、SC / 上舰阈值。存储上拓展订阅本来就有 `overrides` 这几格，只是页面按这张表列。
- **女仆查订阅**：`apps/server/src/ai/read-only-tools.ts` 的 `buildAiSubsView` 按订阅 `id` 为键收两支，停用的不进。B 站条目带 `uid`；拓展条目带平台名（`extensionPlatformLabel`：清单 `display.label` → 拓展名 → 拓展 id）与外部 id，工具那头据此不拿它去问 B 站。「女仆查直播状态」对拓展条目从拓展在播表回答（`liveNow`），拓展没在跑时答「查不到」。

## 要改的时候

| 想干的事 | 动哪儿 / 注意什么 |
|---|---|
| 加一个平台 | **写一个订阅源拓展，BN 不动**（决策 65）。三条边界：契约只有通用的格（平台多出来的东西由 BN 加格、抬契约小号，拓展不能自己声明字段）；平台专属的玩法第一版不开（决策 5）；决策 64 列的那几样只属于 B 站 |
| 往契约里加东西（事件表一格、ctx 一个方法、一种积木、清单一格） | 改 `packages/internal` 的 zod + `packages/extension` 的手写镜像（shape-pin 会逼你两边一起改）；BN 发过版就抬 `EXTENSION_API_RANGE.revision`；更新契约形状守卫的摘要。漏了抬小号，老 BN 会照装新拓展、再把它报的东西整条拒掉 |
| 加一处要遍历所有订阅的地方 | **两支都处理**：先 `isBiliSubscription` / `isExtensionSubscription` 收窄；只该认 B 站的就 `.filter(isBiliSubscription)` 并写一句为什么；绝不拿外部 id 去问 B 站 |
| 按身份找订阅 | 两层 map、不拼串；「先认订阅 id、再认人、绝不跨支」（`target-scope.ts` / `subscription-lookup.ts`） |
| 给订阅挂新的运行期数据 | 按订阅 id 存；高频写的别进配置（`config-changed "subscriptions"` 会整条重建），照 `SubRuntimeStore` 另存；删订阅时的清理听 `subscription-changed` 的 remove |
| 改订阅的 schema | B 站那支的新格要选填或带默认值、落盘照旧剥 `kind` —— 应用内更新会退回旧载荷，旧版写回时剥掉它不认识的格，再升回来得读得进；拓展那支的文件旧版不读，但一行坏了照样开机报错 |
| 改拓展作品怎么推 | 步骤在共用的 `deliverWork`，设置在共用的 `dynamicWorkSettings`（都见 [push.md](./push.md)）；拓展这头只有消费者 `extension-posts.ts`、翻译 `extension-post-work.ts`、公共件 `extension-push-common.ts` —— 公共件拓展直播也要用，别写成作品专属 |
| 让拓展订阅也走某个 B 站功能 | 先看决策 12 / 63 / 64 有没有定过；「看内容的对所有平台生效，看 B 站类型的只对 B 站」（决策 70） |
