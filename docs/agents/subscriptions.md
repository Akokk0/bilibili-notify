# 订阅参考

订阅的形状与身份、两种键、资料与头像、订阅源拓展（清单 / 契约 / 解析门 / 上报）。这份是地图与规矩。

**「为什么这么定」在 [ADR-0019](../adr/0019-subscription-source-opening.md)**（下文括号里的「决策 N」都指它）。推送链本身见 [push.md](./push.md)；总线事件的逐条语义见 [events.md](./events.md)，这里只点名、不重抄。拓展的地基（ctx、装载、一扇门）见 [architecture.md](./architecture.md)「拓展」一节。

## 一句话

**B 站也只是一个来源**（决策 1 / 65）：订阅记录、推不推、推给谁、卡片与历史全归 BN；拓展只管「和那个平台打交道」—— 把主人粘的东西解析成候选、判新、报事件与资料。拓展**写不了订阅**，也不知道推给谁。

## 订阅的形状与身份

schema 在 `packages/internal/src/schema/subscriptions.ts`：**一种形状**，B 站与拓展的订阅都是它（ADR-0021 决策 14、15）。

- **身份** `identity: { sourceKey, externalId }`：`sourceKey` 是 `bilibili` 或拓展 id（不加前缀），`externalId` 是来源那头的 id（B 站就是 uid；BN 不解读，1–256 字）。订的是谁、分派、查找、取色都只看它，一律经 `subscriptionIdentityOf(sub)` 读。拓展 id 不许用保留 id（`RESERVED_INTEGRATION_KEYS`：`bilibili` 与三个内置平台适配器的键），否则会和 B 站的订阅撞成同一个人。
- **其余各格** `id` / `enabled` / `tagIds`（挂的标签，指向 `config/subscriptions.json` 里的标签表，ADR-0034） / `notes` / `routing` / `extraTargets`（附加项的逐目标三态表） / `overrides` / `roastSchedule` / `specialViewers`：两种来源一样。特别关注是公共形状（ADR-0021 决策 17），来源不支持的（今天是拓展）一直是空的；条目是 `{ id, note?, features }`，`features` 只许 `viewerChat` / `viewerEnter` 两把、至少一把，`id` 中立（非空、限长），格式由写名单的路由按这条订阅所属来源的 `externalIdRegex` 核（只核新加的条目，盘上已有的不回头核）。
- 中立的 schema 不认得哪个来源的 id 长什么样：格式由来源在描述符里声明（`externalIdRegex`，整串匹配；B 站声明纯数字，拓展写在清单订阅源那段的 `display` 里），新建订阅时 `routes/subscriptions.ts` 在分岔之前调 `subscriptions/external-id.ts` 的 `externalIdRefusal` 照它核；没声明的来源不替它做主。身份建好以后改不动，已有的订阅不回头核。
- 判「是不是 B 站的」写 `subscriptionIdentityOf(sub).sourceKey === BILIBILI_SOURCE_KEY`：这是过渡写法，第 3a 期 B 站搬进 `bilibili/`、核心只问登记表以后就没有了，「B 站替身」棘轮盯着。

### 内存一份，盘上一个文件（ADR-0021 决策 15）

- `SubscriptionStore`（`packages/subscription`）握一份列表，`subscription-changed` 的 diff 照常发。`findById` 按订阅 id 找；`listByIdentity` 按身份列出**全部**（正常一条，老数据遗留的重复是多条，没有就是空数组）、`findByIdentity` 按身份找第一条，来源与外部 id 两格都相等才算（B 站的 uid 与某个拓展的外部 id 恰好是同一串数字，也是两个人）。
- `ConfigStore`（`apps/server/src/config/store.ts`）把整份订阅连同标签表写进 `<数据根>/config/subscriptions.json`（`{ tags, subscriptions }`，ADR-0034），一次原子写；删标签时订阅上的引用在同一次写里去掉，订阅只许挂表里有的标签。任何一行坏了整个拒、开机报错（`parseSubscriptionFile`）。不跳过坏行：跳过的话下次写回，那几行就永久没了。
- **身份不许改**（`assertSubscriptionIdentityUnchanged`，ADR-0019 决策 50）：换了来源或外部 id 就是另一个人，而资料缓存（连同它引用的图库头像）、历史都挂在订阅 `id` 上。要换人就删了重加。
- **备份**（`apps/server/src/backup/`）：格式版本 4（1.0 起；10-01 设置分文件时从 2 抬到 3，10-02 特性键改名时抬到 4），比当前旧的一律拒收：0.x 导出的（版本 1）提示先装 0.12 恢复再升级（ADR-0022 决策 6），开发期的 2 / 3 只说版本旧、恢复不了。订阅一节，行行带 `identity`，标签表跟它同进同出（恢复时先按 id、再按名字并）。资料缓存（连同它引用的图库头像）不进备份。
- 0.x 的两个文件（`subscriptions.json` 与 `extension-subscriptions.json`）由迁移器合成这一个（`migration/subscriptions.ts`）。

## 两种键（决策 50）

| 键 | 回答 | 用在 |
|---|---|---|
| **身份**：`identity { sourceKey, externalId }`（B 站是 `bilibili` + uid） | 这是谁 | 判重（同一个人只能有一条订阅，见下）、把拓展的上报对到订阅上、历史行找回订阅、颜色 |
| **运行期键**：订阅自己的 `id`（uuid） | 是哪一条 | 推送链（`PushRouter.push`）、历史行的 `subscriptionId`、资料缓存（头像是它里面的图库引用）、拓展在播表、女仆查订阅的视图、增删改接口、备份的合并计划 |

- 🔴 **身份别拼字符串当键。** 外部 id 是拓展给的不透明串，什么字符都可能有：拼就得选分隔符、做转义，当文件名、进 URL 还得再转义一次。按身份查一律**两层 map**（拓展 id → 外部 id），样板是 `runtime/target-scope.ts` 与 `apps/web/src/pages/up/subscription-lookup.ts`。拼成 `extensionId:externalId` 的只有两处、都只给人看：取色（`packages/internal` 的 `identityColor` / `extensionColorSeed`，面板与服务端出图共用一份，ADR-0020 决策 15）与推送层的日志标签（`subscriptionLabel`）。
- **绝不跨支**：外部 id 恰好等于某个 B 站 uid，也是另一个平台上的另一个人。
- **同一个人只能有一条订阅**（守卫 9）：闸在写盘的 `ConfigStore`（规矩是 `packages/subscription` 的 `findNewIdentityDuplicates`），逐条写与整体替换都过它，新建撞了回 409 `conflict`。判据是这次写入有没有**新增**重复，所以盘上遗留的一对照样能改、能删；开机读到只记一句警告。恢复备份先按 id 对、再按身份并入（id 留本机的、内容用备份的），备份自己里面就有一对的整份拒收、点名是谁（`backup/restore.ts`、`backup/service.ts`）。
- 老版本留下的同一个人两条订阅**各推各的路由**。**作品这一路 3a-28 起每条各一份**：来源上下文的 `reportPost` 按身份取全部订阅（`listByIdentity`）逐条交给作品入口，各推各的、`post-detected` 各发一次（统计各记各的），一条停用或关了作品开关只丢它自己那份。**3b-22 起直播也每条各一份**：`reportLive` 与 `reportLiveInteraction` 同样按身份取全部订阅，再按每条订阅现折的设置判。

### 哪些地方故意只认 B 站

都按身份的来源过滤（`subscriptionIdentityOf(sub).sourceKey === BILIBILI_SOURCE_KEY`），旁边有一句为什么：

- **直播监听视图与 `getModuleState`**：名单给来源的是 `SourceSubscriptionView`，B 站来源的 `ListenerManager` 只看 `monitorsLive`。`getModuleState` 的「直播监听」那一格（3b-14 起问 internal 的 `needsLiveMonitor`：启用着的订阅里有没有哪条要监听，只看折好的开关与特别关注名单，不看推送目标；3b 起判据收紧：五把直播类开关任一开着，或 `viewerChat` 开着且名单 `specialViewers` 上有人带 `viewerChat`，或 `viewerEnter` 开着且名单上有人带 `viewerEnter`，所以五把直播开关全关、名单上有人而特别关注开关也关着的订阅不再连直播间；判定的入参是 `{ features, specialViewers }`，调用处直接递 `resolve(sub).features` 与 `sub.specialViewers`；特别关注两把特性键由 `specialDanmaku` / `specialUserEnter` 改名 `viewerChat` / `viewerEnter`，见 ADR-0021 决策 17、ADR-0027 决策 1）。这一格还要求该订阅的来源实现了直播：在册来源有 `fetchLiveStatus`，或拓展声明了直播周期。动态那一半 3a-28 起不在这里了：B 站来源吃核心给的名单（见下「来源登记表与名单」），原先的 `buildDynamicSubsView` / `subscriptionOpsToDynamic` 删了。拓展订阅的轮询是拓展自己做的。
- **关注**：`bilibili/follow-sync.ts`、新建订阅后的 B 站资料刷新（`routes/subscriptions.ts` 调 `ProfileRefresh.refreshSubscription`）、查 UID / 搜名字（`/api/subscriptions/lookup`、`/api/subscriptions/search`）。关注只为从关注流里拉到动态，所以**只对「启用中、折好的作品开关开着」的 B 站订阅做**（开关的折法与来源名单是同一份，见下「来源登记表与名单」；BN 只补关注、从不取关），细节见下「来源登记表与名单」里的「关注同步」一条。
- **资料刷新**：`runtime/profile-refresh.ts` 按 `globals.profileRefreshCron` 针对启用中的订阅、经来源登记表调 `fetchProfile`，同一来源串行、不同来源并行。B 站已走这一条；拓展仍未并进来源登记表，靠报资料更新，3b-42 再接。成功后写同一个资料缓存、记粉丝样本并整份发 `followers-refreshed`。新建订阅当场单条刷新一次。
- **统计 / 锐评**：`routes/stats.ts`、`stats/roast-*.ts`、`runtime/roast-scheduler.ts`，面板的 Stats / Cards 页。⚠️ 这是**今天的现状、不是定案**：决策 63 定了统计页 / 粉丝曲线 / 锐评第一版就管拓展订阅（施工在 ④′，[ADR-0020](../adr/0020-stats-cover-extension-subscriptions.md)），卡片页的按 UP 预览放到 ⑤ 定。**采集已经两支都记**：`stats/recorder.ts` 挂着各来源的适配（在册来源的「在记」是 `registry-source.ts`，拓展上报是 `extension-source.ts`），拓展订阅的作品、场次、粉丝、「在记」都按订阅 id 落盘。**`GET /api/stats/overview` 也两支都列了**：行以订阅 id 为键、带 `identity`，拓展行「那天有没有记录」只看它自己的「在记」（不借 B 站的粉丝采样），在播取引擎的 `liveSession`（场次模块，`live/live-sessions.ts`）、当前粉丝取资料缓存（停用的退回样本末值）。**统计页也两支都画了**（S5）：行按订阅 id 选中 / 聚焦，颜色走 `identityColor`，拓展行带平台徽章；CSV 的身份列是「平台 / 外部 ID」。**锐评也两支都管了**（S6，决策 12 / 14 / 15 / 18）：一张榜混着比（「至少 2 位」数两支加起来的人头），提示词不写死「B 站」、数据表多一列「平台」（平台名由来源描述符给，取不到写来源键）；`stats/roast-subject.ts` 的 `roastSubjectName` 走 contract 的 `displayNameOf`（资料名 → 身份标签），不再按来源分叉。结果、单人锐评、推送请求、路由参数（`/roast/:subscriptionId`、`/roast/run/:subscriptionId`，面板编码进路径）、草稿里的 UP **一律是订阅 id**；0.x 按 uid 记的草稿由迁移器换成订阅 id（`migration/roast-drafts.ts`），对不上的丢掉。单人定时锐评按订阅 id 排、跑、发，`PATCH /api/subscriptions/:id` 的审批闸两支都拦。出卡（`stats/roast-deliver.ts` 的 `makeUpMeta`）：颜色走 `identityColor`（同面板），头像（B 站与拓展）从图库读字节转 data URL（面板用的同源地址 `/api/images/<ref>` 截图加载不到，同 ADR-0019 决策 68 的坑）。
- **新建订阅的路由**（`routes/subscriptions.ts`，`POST` 新建那一支）：身份的来源键不是 `bilibili` 的一律当拓展订阅，只认「装着的 v2 订阅源」（`subscriptionSourceRefusal`），不问来源登记表 —— 在册的内置来源经接口建不出订阅（3a-42 对拍查出，对拍名单 N01；第 4 期 `searchCreators` 落地时一起改；3b 起来源的 `searchCreators` 方法先造、B 站实现、只给 AI 的搜人工具用，`GET /api/sources/:sourceKey/creators` 与面板仍第 4 期。来源描述的 `creatorNoun` 与 contract 里的叫法函数也提前到 3b 造，面板上的叫法仍第 4 期）。
- **统计「这个小时在记」**（`stats/registry-source.ts`、`stats/extension-source.ts`）：两个来路 —— 核心对**所有在册来源**记（`attachRegistryStatsSource`：来源在登记表里，且没有登录口或登录口现读是 `logged-in`（`confirming` 不算），就按每条订阅的 `recordsPosts` / `recordsLive` 记当前小时；挂上时、每 `RECORDING_CHECK_MS`（1 分钟）、`subscription-auth-changed` 时各看一眼），与拓展订阅的上报事件（登记表里没有的键不记，照旧由 `extension-source.ts` 按上报记）。登录丢了（现读到 `expired` / `logged-out`）时同一模块忘掉那个来源名下的在飞场次，统计不再听 `auth-lost` / `auth-restored`。这里的「来源在跑」只看登录；作品入口的闸与女仆查直播仍用 `SourceStatusReader`（在册即在跑），两种说法合成一个读口归第 4 期。3b-42 把拓展来源登进登记表后，没有登录口的拓展会被当成「在册即在跑」，要定它的在跑怎么算。
- **`status` 指令的「登录」行**现读来源登记表：每个带登录口（`Source.auth`）的来源各一行（「<label>登录：<状态>」），其余几行（上次抓取一类）是各来源自己说的；`login [来源]` 同样从登记表挑来源，不带词且只有一个就直接扫，有好几个就列出来（3b-06 已落，对拍 P21，原名单 N17）。
- devtools 场景挑订阅（`compose.ts` 的 `provideDevtools` 里那段 `subs`，3a-28 从入口搬来）—— 它造的是 B 站事件。
- 决策 64 列的**只属于 B 站**：群里链接自动出卡、私聊指令按 uid 订阅、弹幕那一族（SC / 上舰 / 特别关注 / 词云 / 总结）。

反过来，**遍历所有订阅**的地方所有来源都要处理（订阅只有一份列表，就是为了它们不静默漏掉拓展的订阅）：删推送目标时清引用、目标别名改写、开机清资料缓存（`pruneOrphanSubscriptionState`；它丢掉的条目引用的头像由图库清扫收走，没有单独扫头像的一步）、删皮肤 / 卡片背景前查「还有人在用」、备份、健康页。

## 来源登记表与名单（B 站这一支，3a-28 起）

**B 站这一支经来源登记表走；拓展那一支仍走自己的通道**（上面「上报」一节的 `receiveReport` → `subscription-reported` → `bindExtensionPosts`），不经这张表，3b 并进来。

- **类型**住 `packages/internal/src/source.ts`：`Source { descriptor, searchCreators(…), fetchProfile(identity, signal), fetchLiveStatus?(…), liveInteractions?, health?(), start(ctx), stop(), auth? }`（`health?()` 3a-40 加的，同步、可选、只交一句 `{ summary }`，`status` 指令读它）、`SourceContext`（公共五格 `logger` / `signal` / `onDispose` / `state` / `secrets`，加 `subscriptions()` / `onSubscriptionsChanged(fn)` / `reportPost(externalId, report)` / `reportLive(externalId, report)` / `reportLiveInteraction(externalId, report)` / `reportProblem(…)` / `resolveProblem(…)`（3a-30 加的两个，见下「问题」）/ `registerLinkResolver(resolver)`（3b-27 加的：来源在自己的 `start(ctx)` 里登记链接解析器，键取这个来源的键，停下时宿主自动撤，见 [commands.md](./commands.md) 末尾「链接解析」）/ `registerAiToolProvider(provider)`（3b-34 加的：来源在自己的 `start(ctx)` 里登记只读 AI 工具提供方，键取这个来源的键，停下时宿主自动撤）、`SourceDescriptor { label, externalIdNoun?, postNoun?, externalIdRegex?, membershipPrograms? }`（`label` 必填，平台名，`status` 里冒号前取它，3a-40）、`SourceSubscriptionView { externalId, features, monitorsLive }`。宿主逐格列出公共五格、不展开集成上下文（B 站交进来的对象运行时带着 `http` 与 `cookies`，展开会原样抄进来）。
- **登记表** `SourceRegistry`（`apps/server/src/subscriptions/registry.ts`，建在 `AppRuntime.sourceRegistry`）：一个来源键一个主人，`register` 认领键后 `await source.start(ctx)`，`start` 抛了就放键、错原样抛；回的把手撤登记时放键并调 `source.stop()`（不等它，失败只记 warn，`stopQuietly` 与适配器登记表共用）。`get` 问键，`list` 按登记先后列全部（会员档位读口用）；对外的来源视图带 `descriptor`、`searchCreators`、`fetchProfile`、可选的 `fetchLiveStatus` / `liveInteractions` / `health` / `auth`，方法逐格转发以保住 `this`。调登记的是 `compose.ts` → `engines.registerSource`（来源的上下文由 `createEngines` 建，因为作品入口、总线、关停次序都在那里）；`engines.dispose()` 先停登记过的来源、再关作品入口，所以 `stop()` 之后不许再上报。
- **名单**是 `sourceSubscriptionViews`（`subscriptions/source-subscriptions.ts`）算出来的，全仓只有这一个算法，每次现算、别缓存：只取身份落在这个来源上、**启用中**的订阅；`features` 是按全局默认折好的开关（订阅覆盖压过全局），不看有没有目标；同一个人遗留的重复订阅合成一条、`features` 取并集，`monitorsLive` 取或；条目按第一次出现的先后。作品开关关着的人**也在名单里**（只是 `features` 里没有 `post`）：名单只按启用与否列，开着哪些由 `features` 说，「查不查」由来源照它自己定 —— B 站动态引擎的 `postAnchors` 只含 `features` 有 `post` 的人，B 站的关注同步也只对这些人做（3a-31，见下「关注同步」）。
- **「名单可能变了」**有两路：`subscription-changed`，与 `config-changed` 里 `globals` 那一档（全局特性开关变了要重算，不去列举哪个输入变了）。两路都无条件叫全部回调，宿主不替来源去重；每个回调单独 `try/catch`，一个抛了不影响排在后面的。来源自己对比新旧名单，没有进出就什么都不做。
- **上报**：`ctx.reportPost(externalId, report)` 按身份 `listByIdentity` 取全部订阅，逐条交一份 `PostEvent`（`postNoun` 取描述符的）给作品入口；没有订阅就记 debug 丢掉，来源已停下还在上报则记 error 丢掉。停用的、作品开关关着的不在这里筛，入口按订阅现折设置再查一次（这就是「核心收到上报后兜底再查一次」）。
- **问题**（3a-30）：来源把「主人该知道的事」报给核心用 `ctx.reportProblem({ externalId?, code, message, notify?, recoveryMessage? })`，好了用 `ctx.resolveProblem({ externalId?, code, notify? })`；都是 `void`。不带 `externalId` 是来源自己的问题（如请求被风控），带了由宿主（`subscriptions/source-context.ts`）按身份取全部订阅、每条各记一条（停用着的也记，一条都没有就记 debug 不收）。同一个 报的人 + 对象 + code 在问题表里只有一条，再报只换文案；`code` 要 snake、`message` / `recoveryMessage` 不能是空白，不合格的、以及来源已停下还在报的，一律丢弃并记 error（内置来源被拒就是 BN 的 bug）。`notify: true` 请核心私聊主人（由 `problems/problem-notifier.ts` 发，细节见 push.md「不走这条链的旁路」）；`recoveryMessage` 是清掉且当初真私聊过时核心发的那句，不给用通用说法；`resolveProblem` 的 `notify: false` 表示这次不是修好了、只是不再适用，不补「已恢复」。来源停下（撤登记、登记失败）时它报的整批由宿主清掉、订阅删了关于它的由宿主清，都不补「已恢复」。B 站这一支由 `bilibili/problem-layers.ts` 的分层上报器代报（风控 → 各项请求失败，同时只留最上面一层；登录掉了时两层先被压下，登录本身归宿主报）：动态与直播引擎都不直接碰 `ctx`，往上报器里报，来源 `start(ctx)` 的最后一步才把它接到 ctx 上、整份补报，`stop()` 第一步先摘；换语言时整份重报（只重报，不复位 `muted`，不重跑 `apply*`）。**拓展那一支** 3b-38 起与来源、适配器用同一个签名（`activate(ctx)` 上的 `reportProblem` / `resolveProblem`；来源上下文多 `externalId?`，适配器上下文多 `connectionId?`），`recoveryMessage` 与 `notify: false` 的意思同上。🔗 **现状（3b-51，10-20）：下面两处已落**：① 集成写的 `message` / `recoveryMessage` 一律平实、只写发生了什么与平台这一侧自己会怎么做（如「拉取动态失败（错误码 -352：原话），每 5 分钟会自动重试一次」），不称呼主人、不写面板哪一页、哪条指令之类宿主的界面与操作，平台的数字错误码写进 `message`、不占 `code`；私聊时宿主按口吻补完整，写者名由三个上下文入口盖进问题表的 `writtenBy`（不在 `Problem` 上），宿主直写的整句不盖；② 有登录口的来源不报登录问题，宿主订它的 `auth.onChange` 看 `AuthState` 报与清（`expired` 进表并私聊，`logged-out` 只进表，`logged-in` 清，扫码中 / 确认中 / 出错保持上一次的结论），记在来源名下，整句由宿主写并带指路（面板账号页、`login <来源>` 指令），交的是取字函数、表在换语言或口吻时重跑；报与清住 `subscriptions/login-problems.ts` 的 `watchLoginProblems`，`builtin-sources.ts` 登记来源时接上；B 站不再报 `auth_lost`，「登录掉了时把风控、请求失败压下去」的分层仍在 B 站。拓展的设置读不懂由装载器报 `settings_invalid`（记在拓展 id 名下，不私聊）。
- **「来源在跑吗」**读口 `SourceStatusReader.running(sourceKey)`（`subscriptions/source-status.ts`）：登记表里有它，或拓展装载器说这个拓展订阅源在跑。作品这一路的设置读口（`makePostSettingsReader`）用它判「来源没在跑就不推」，入口、装配开头、回问三处每次现读。只有「在不在跑」一个取值；3a-39 没造 `failed` / `settings-invalid` 这些取值，也没造内置来源的运行状态读口（今天没有读者，再看的时机是 3a-40 的 `health()`）。**来源在跑不等于它里面每一样都在跑**：B 站设置读不懂时来源照常在册、这个读口读成在跑，停着的那一样（动态，或定时的登录检查）在问题表里（`dynamic_settings_invalid` / `login_check_settings_invalid`）；这时动态引擎没造，`BiliSource.dynamic()` 回 `undefined`，`status` 指令的「上次抓取」写「还没抓过」，开发场景「造一条动态」抛的提示是「没登录，或动态那一格设置读不懂」。
- **会员档位读口** `MembershipTierReader`（`subscriptions/membership-tiers.ts`）：卡片预览路由与皮肤预览按档的 key 找档（`byKey`）、取最低一档（`lowest`），读的是登记表里各来源描述符声明的会员体系；B 站的描述符声明的是舰长体系。⚠️ 档的 key 上不带来源也不带体系 id：`byKey` 跨来源按登记先后取第一个，`lowest()` 只看第一套声明了档的体系，两个来源的档 key 撞名时先登记的赢（3a-42 对拍查出，3b 会员体系中立化时再动，见总计划「以后再说」）。
- **B 站的动态引擎**由 B 站来源（`bilibili/source.ts`）在 `start(ctx)` 里造并起（3a-39 起：动态那格设置读得懂才造；读不懂就不造、报 `dynamic_settings_invalid`，改好保存当场造并起；起来之后 cron 变了走引擎的 `updateConfig`；晚起的引擎照下面这张表的规矩，锚点是进表那一刻的「现在」，停着期间发的动态不补推），吃 `ctx.subscriptions()`，只维护**一张表** `postAnchors`（uid → 时间线锚点，秒）：名单里 `features` 含 `post` 的人（在名单里且作品开关开着）才在表里，进表那一刻锚点是「现在」，离开（退订、停用、关作品开关、全局作品开关关掉）就删，所以关了作品开关再打开一律不补推关着期间的动态；表里的人才翻译、抓图、交作品。名单变了走 `syncSubscriptions()`（照名单对一遍、有进出才记一行 info 并 `reconcileJob`，**不重启 cron**，免得打乱轮询相位；表空则停 cron，没人要动态时不空拉）。重启检测器（`restartDetector`）只留给 `start`、登录恢复、退避到点三处。引擎的 `stop()` 清空这张表，所以关停那一刻还在抓图的那条动态过不了交出前的重校，不会在停下之后再上报。
- **关注同步**（B 站这一支）：动态走 B 站的关注流，没关注就收不到，所以关注只为动态；直播用不着。**谁要关注**由 `bilibili/follow-sync.ts` 的 `watchFollows` 从 `ctx.subscriptions()` 里定：只取 `features` 含 `post` 的人，与动态引擎的 `postAnchors` 同一个判据；同一个 `externalId` 的遗留重复订阅只发一次请求。只开直播的、停用的订阅既不查关注关系也不补关注；BN 只补关注、从不取关。**什么时候跑**：① 来源开机，已登录才跑全量；② `auth.onChange` 从非登录恢复成 `logged-in` 时跑全量；③ `onSubscriptionsChanged` 到了就重算关注集合，只对相比上一次**新进集合**的 `externalId` 跑一轮。订阅被启用、作品开关打开、全局作品开关打开、订阅覆盖被清掉而全局开着，以及新建订阅，都会经过第 ③ 条；从关注范围离开的人按「不再适用」清掉他的 `follow_failed`。没登录时只更新集合、不发请求，登录恢复那一轮补上。**新建订阅**（`POST /api/subscriptions`）不在路由请求里当场关注，回应也不带关注结果；名单变化后由 B 站来源异步补。整批关系查询先查再只补缺的，稳态下没有写请求；批查回 `unauthorized` 整批跳过、不降级，单个补关注回 `unauthorized` 也停下这一轮，其他批查失败才降级为逐个幂等补关注。失败报 `follow_failed`（带 `externalId`、挂在那个人的订阅上、`lasting: true`、只进表）；补成功或查到已关注就清掉，问题句仍是「未关注该 UP —— 收不到动态（原因）」。`followed` / `followError` 不再存任何地方；订阅列表回应用 `problems` 通用显示挂在每条订阅上的问题，`problems-changed` 到了面板重取订阅列表。

## 资料与头像

**资料缓存**是 `SubscriptionStateStore`（`apps/server/src/runtime/subscription-state-store.ts`，`<数据根>/runtime/subscription-state.json`，按订阅 id）里的 `cachedProfile: CreatorProfile { name, avatar?, bio?, followers?, fanClubName?, refreshedAt }`。它**不是配置**：写它不发 `config-changed`（那一档会重建路由表、通知拓展、让引擎 reconcile），面板看得见的名字 / 头像 / 粉丝变了才经 `runtime/profile-cache.ts` 合并发 `subscription-profiles-changed`。`GET /api/subscriptions` 在 `toDTO` 里把它 join 进 DTO。

| | B 站 | 拓展 |
|---|---|---|
| 新建时 | 路由调 `ProfileRefresh.refreshSubscription` 立刻经来源 `fetchProfile` 刷这一条，失败不回滚新建 | 面板把解析门里挑中的候选（`{ id, name, avatar?, fans? }`，头像是 data URL）预填成 `SubscriptionCreateRequest` 的 `cachedProfile { name, avatarUrl?, followers? }`，随 `POST /api/subscriptions` 交进来（data URL 是个网址，所以放 `avatarUrl`），`seedExtensionProfile` 种资料、头像存进图库 |
| 之后 | `ProfileRefresh` 按 `profileRefreshCron` 经 B 站来源的 `fetchProfile` 刷新启用中的订阅；B 站每轮取整张用户卡（名字、头像、签名、粉丝数），粉丝牌名从来源自己的 `ctx.state` 带入 | 拓展仍未并进来源登记表，继续认「报资料更新」（`reportProfile`）；它的资料缓存与时序进同一份 `followers-refreshed` 快照。事件里带的作者只上卡、不改资料（决策 54） |
| 头像存的是 | `avatar`：抓进图库的引用；头像来源地址与引用记在 B 站自己的 `ctx.state` 的 `profile:<uid>`（`bilibili/profile.ts` 的 `syncProfileAvatar`：480 宽、第一帧、webp 的缩放版，缩放版抓不到不回退原图）。只给订阅名单里的人抓头像、写状态；地址与引用没变就不重抓。核心资料缓存不存 `avatarUrl` | `avatar`：图库引用 `ImageRef`，面板从 `/api/images/<ref>` 取；没有头像就**缺着 `avatar`**，不写空串。**卡片也读它**：动态与直播出卡时按订阅 id 读 `cachedProfile.avatar`（缺键就是没有），动态外层作者、开播 / 直播中 / 下播、会员、醒目留言卡的主播头像都读这一格，出卡时零网络 |
| `followers` | 资料刷新来的粉丝数 | 可缺 —— 缺了写 0 就是在面板上印一句「0 粉丝」的假话 |

**资料的落盘**：拉来的资料与 `subscription-reported`（`kind === "profile"`）报来的资料共用 `runtime/profile-cache.ts`：给了哪格改哪格（简介 `bio` 给的是空串就缺这一格），头像没给就沿用并 `keep` 续期，`refreshedAt` 每次更新。拓展报资料由 `runtime/reported-profiles.ts` 接；停用的订阅照样更新，订阅刚删时报上来的不再种，写入排一条队。面板看得见的名字 / 头像 / 粉丝**真变了**才发 `subscription-profiles-changed`（250ms 窗口合并）。

**拓展订阅的头像在图库里**（决策 49；进图库见 ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗）：资料缓存里 `avatar` 是 `ImageRef`（`<sha256>.<ext>`），面板走图库的同源读口 `GET /api/images/<ref>`（`apps/web/src/utils/up-display.ts` 的 `profileAvatarUrl` 是唯一的取址处：有 `avatar` 走读口，没有退首字）。

- 两条来路都走 `runtime.profileImages`（图库的存图口，资料缓存登记成引用方后才拿得到，装配在 `runtime/bootstrap.ts`）：新建订阅时的 `seedExtensionProfile`（面板交的 data URL 先在路由层过 `decodeSubscriptionAvatar`，128 KiB 的字、只收 png / jpeg / webp、魔数得对得上声明），与「报资料更新」（`reported-profiles.ts`，字节过 `checkSubscriptionAvatarBytes`，约 96 KiB 封顶）。两道关都在 `runtime/subscription-avatar.ts`，**不收 gif、不收 SVG**；图库自己再按嗅探认格式。
- 图按内容起名：同一张图再报一次引用不变（面板地址不变，浏览器缓存照样命中）。没给头像时沿用旧的引用 —— 沿用也是「抄引用」，先 `keep` 续期；图已经不在了就缺着 `avatar`，不留悬空的引用。
- **没有「删订阅顺手删头像文件」这一步**：订阅被删，资料缓存里没了这一条（`ProfileRefresh` 听 `subscription-changed`、开机 `pruneOrphanSubscriptionState`），头像不再被引用，由图库清扫（每 6 小时加开机，过了 24 小时宽限期）收走；另一条订阅还引用着同一张图时不收。资料缓存仓的 `listImageRefs()` 交名单，没载入就被问会先载入再答。
- 出卡时 `/api/images/<ref>` 截图加载不到：拓展作品卡与拓展直播卡的头像是图库引用，出图器经注入的 `resolveImageRef` 读字节转 data URL（作品：`postFromReport`；直播：`live/live-card-input.ts` 的 `liveCardInputFromDetails`，事件带了作者头像字节就存进图库用它，没带用资料里的引用，哪儿都没有就没有头像、头像块收起，决策 54 / 68，ADR-0021 决策 22 下 10-05 的 🔗）；锐评卡（`stats/roast-deliver.ts`，B 站与拓展同一条路；资料里还没有 `avatar` 就没有头像、画首字母圆牌）图只认字符串地址，用 `runtime/extension-push-common.ts` 的 `readProfileAvatar` 读字节、`imageDataUrl` 转 data URL。拓展作品与直播卡上作者名和模板 `{name}` 走 contract 的 `displayNameOf`：事件里的作者名 → 资料名 → 身份标签（别名 `name` 已退役）；面板上标「备注」的 `notes` 是自由文字，**不当名字用**（决策 77）。
- 历史行的头像快照 ⑳d 起叫 `avatarSnapshot`、只装图库引用：拓展行写行时抄资料缓存里的 `avatar`（历史仓先续期，续不上不写这一格）；B 站行同样抄资料里的 `avatar`（B 站头像进图库后；资料里还没有 `avatar` 的行缺着，面板退到订阅现在的头像〔`profileAvatarUrl`〕）；过了保留期的行面板也不用快照。

**显示名与颜色**（`apps/web/src/utils/up-display.ts`）：

- `displayName`：资料名 → B 站「UID xxx」/ 拓展「主人起的名字 → 外部 id」。
- `subscriptionColor`：**颜色跟着人走** —— B 站按 uid，拓展按 `extensionId:externalId`（带冒号与拓展名，永远不等于纯数字 uid，不会和 B 站 UP 撞色）；删了再加颜色不变。历史行 `historyRowColor` 同一条规矩。
- 历史行的身份兜底 `historyRowIdentity`：「UID xxx」/「平台名 · 外部 id」，平台名取不到（拓展卸载了）写拓展 id。
- 平台名与徽章：`apps/web/src/pages/up/subscription-source.ts` 的 `subscriptionPlatformOf`，从清单的 `display` 来。

## 订阅源拓展

### 清单 `contributes.subscription`（决策 5 / 16 / 51）

schema 在 `packages/internal/src/schema/extension-manifest.ts`，只有清单 v2 开得了。样板是 `extensions/fake-source/`（开发用假源：解析门现编候选，页上的动作按钮造五种上报，外加坏图、多一格两种反例）。

- `display`：`label`（全名，平台选择那一排）、`shortLabel`（≤8 字，卡上的方章）、`color`（只收 hex）、`postNoun?`（「作品」；不给时面板的特性标签叫「动态」，核心拼 AI 提示词时叫「作品」—— 提示词那一处原先也叫「动态」，3a-42 改了）、`lookupPlaceholder?`（新建订阅时输入框那句提示）。
- `events`：`post` / `liveStart` / `liveEnd` 的非空、不重复子集 —— **这就是能力声明**。配置弹层只列它对应的特性（`SUBSCRIPTION_EVENT_FEATURES`：`post → post`、`liveStart → liveStart`、`liveEnd → liveEnd`；声明了开播与下播两种事件的再加 `liveStreaming`，见 `featuresForEvents`；面板 `featuresForEvents` / `visibleFeaturesOf`），报了没声明的种类整条拒。
- `cardSkin?`：自带皮肤目录（决策 13 / 14，⑤ 施工）。
- 面板拿到的是 `manifestSubscriptionView`（`apps/server/src/extensions/context.ts`）—— **只从清单来、不问代码**，所以拓展停着也画得出订阅是哪个平台的（决策 41）。

### 契约档位与契约小号（决策 18 / 59）

- `EXTENSION_API_RANGE = { min: 2, current: 2, revision: 0 }`（第 1 版的退路已删，第 1 版清单判「版本太旧、不兼容」）。清单的 `apiVersion` 是要的档位（落在 `[min, current]` 才收），`apiRevision` 是要的小号（缺省 0）；`apiVersionAccepted` 判「装得了吗」，装包（`extensions/install.ts`）、发现（`discover.ts`）、市场（`marketplace.ts`）用同一把尺子。宿主**先单读 `apiVersion`，再读小号，再按那一档的格式校验**，旧宿主说的是「版本不合」而不是「清单读不了」。
- 🔴 **拓展能用的东西变多**（事件表加一格、ctx 多一个方法、多一种积木、清单多一格）且**对应的 BN 已经发过版** → `revision` 加一。为别的原因发版不动它；**只增不归零**（抬档位也不归零）。不兼容的改动 = 抬 `min` 并删掉对应的退路。v2 还没发版，里面现有的一切都算 0 号。
- 守卫 `packages/internal/src/schema/__tests__/extension-contract-shape.test.ts`：清单 v2、解析门候选、视图、五种上报这几份 zod 转成 JSON Schema 算摘要，与 `PINNED_REVISION` **成对**钉住，形状一动就红，报错里写着该怎么改（发过版 → 抬小号 + 更新摘要与 `PINNED_REVISION`；没发版 → 只更新摘要；新摘要照 Received 填）。以后加一份拓展交给 BN 的 schema，就往它的 `CONTRACT` 表里加一行。
- ⚠️ 守卫**看不见的**：`refine` / `superRefine` 里的规矩、图的格式与单张字节上限（在 `z.custom` 的判定函数里）、整条上报的图总量上限（在 `checkSubscriptionReport` 里）、ctx 多一个方法（纯 TS）。放宽这些同样要抬小号，自己想。
- `packages/extension` 里给拓展看的 TS 类型是这些 zod 的**手写镜像**（拓展进不来 internal），由 `apps/server/src/extensions/subscription-shape-pin.ts` 双向严格相等地钉住。

### 注册、解析门、新建

- **注册**：`ctx.registerSubscriptionSource({ lookup })` → `SubscriptionSourceHandle`（契约在 `packages/extension/src/index.ts`）。只 v2、且清单开了这一口；一个拓展只注册一个（一个拓展就是一个平台，决策 9）；收摊时摘掉。**没有单开一张注册表**：订阅源记在各拓展的 ctx 上，装载器的 `LoadedExtensions.lookup(id, q)` 转给在跑的那一个；「哪些拓展是订阅源」一律从清单读（`/api/ext` 每行的 `subscription`）。
- **解析门** `GET /api/ext/:id/lookup?q=`（`apps/server/src/routes/extensions.ts`，决策 11 / 52）：只在 `/api/*` 下、吃面板鉴权（拓展拿主人的 cookie 去平台查人）。候选 `{ id, name, avatar?, fans? }` 最多 20 条、`id` 不重复、头像只收位图 data URL（`SubscriptionCandidatesSchema`，`schema/extension-subscription.ts`），宿主先核形状。失败各有码与原话（状态码从码推，话在 `extensions/context.ts` 的 `lookup` 里造）：没在跑 / 不是订阅源 `not_found` 404；15 秒超时 `timeout` 504（拓展收到的 `signal` 同时中止）；拓展抛了 `unavailable` 503「拓展查询出错」；候选不合规矩 `invalid` 502「交回的候选不合规矩」并点名原因（请求本身没错，是拓展交回了不合格的东西，所以不回 400）。查询**可以并发**，不设「在跑时再按回 409」。
- **新建**：面板只在至少一个订阅源**在跑**时出平台选择（`runningSources`），否则与只有 B 站时一模一样。`POST /api/subscriptions` 带 `kind: "extension"` 且 id 是新的 → `createExtensionSubscription`：`extensionId` 得是**装着的** v2 订阅源（不要求在跑，`subscriptionSourceRefusal`），同拓展同外部 id 已有就 409，建完拿候选种资料与头像。已有的拓展订阅整份 POST 回来改照常走通用那条路，身份几格改不动。
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

- 拒 = 拓展那头 reject 一个带原因的 `Error`（拓展不接这个 Promise 也不会变成 unhandledRejection）。拒与丢格都只从 ctx 里**唯一**的出口 `recordDiscrepancy` 走：日志一行 + `onReportDiscrepancy` → `extensions/report-discrepancies.ts`（每个拓展最近 20 条、只在内存、卸载清空）→ `ExtensionDTO.reportDiscrepancies` → 拓展详情页「上报出入」框（决策 60）。不私聊主人 —— 系统性的 bug 就是每条作品一条私聊。
- 施工定下的数：时刻一律**毫秒**、不早于 2000 年（交成秒当场报出来）；图一律交 `Uint8Array`、按魔数认格式、收下的是 BN 自己拷的一份；作品图 png / jpeg / webp / gif，单张 ≤ 8 MiB、每条 ≤ 30 张、整条合计 ≤ 64 MiB；头像只收 png / jpeg / webp；作品的话题（`topics`，话题名、不带 `#`，两头的 `#` 与空白先剥掉）每个 1–64 字、最多 20 个，坏的只丢那一项，重复的去掉（决策 55 的 09-24 🔗）。
- 🔴 **判新归拓展，BN 不兜底**（决策 53）：不判新、不按作品 id 去重、不限流，报什么收什么；开机第一轮只记基线不报是拓展自己的事（假源照这条写）。
- 今天的消费者：
  - 作品推送（`posts/extension-post.ts` 的 `bindExtensionPosts`，收 `post`）：整条上报排进这个绑定自己的一道串行闸（保翻译的次序）→ 逐条订阅：查订阅 → 翻成中立的 `Post`（`postFromReport`，图在这一步就写进图库）→ 交给核心入口 `PostQueue`（与 B 站动态同一个入口）。入口里再判订阅在、启用、作品开关开着、拓展在跑（不该推的丢掉、不发 `post-detected`），然后按订阅排闸跑与 B 站动态同一份的 `deliverPost`：`filterPost`（关键词 / 正则 / 白名单加四个类型开关，对拓展作品和 B 站一视同仁）→ 出卡 → 点评 → 回问 → 模板 → 版式 → 推送。推出去之后落历史的拓展行、可以人工重推；途中意外抛错只记日志不重试（决策 77）。细节见 [push.md](./push.md) ①。
  - 资料落盘（`runtime/reported-profiles.ts`，收 `profile`）。
  - 直播场次（`live/extension-live.ts` 的 `bindExtensionLive`，3b-22 起），v2 的 `liveStart` / `liveEnd` / `liveStatus` 先存封面与头像，再翻成中立的 `reportLive`；B 站与拓展随后共用 `LiveSessionEngine` 与 `LiveTable`。`live/live-table.ts` 的 `LiveTable` 只记在播行；场次每一次变化由引擎发 `live-session-changed`，面板从 `push-events` 收帧后失效重取或在播行就地补格（3b-23）。开播 / 下播 / 周期「正在直播」卡、重启补报、断流接续由 `live/live-push.ts` 的 `bindLivePush` 推（决策 57 / 58 / 61 / 67）：每条订阅一套状态与一道串行闸，最新状态取在播表；周期推送要这条订阅开着 `liveStreaming`、且源声明了开播与下播两种事件，还只在上次推送后收到过新状态时才推，否则记一条「跳过一轮」进上报出入框；重启补报要 `liveStart.catchUpOnBoot` 且开播开着；拓展停了 / 订阅停用 / 三个直播特性（开播、正在直播、下播）都关，计时器与等待中的下播卡作废、不补推。
- 相关事件 `subscription-reported` / `subscription-profiles-changed` / `live-session-changed` / `live-viewers-changed` / `extension-stopped` / `extension-report-discrepancies-changed` 的语义见 [events.md](./events.md)。B 站与拓展的在播都走同一组中立场次事件；会员与醒目留言走回调、不开总线事件，互动汇总随场次结束帧交统计（3b-23）。资料变了**不发 `config-changed "subscriptions"`**。

## 高级规则与女仆查订阅（决策 64）

- **高级规则「按 UP 定制」**：`apps/web/src/pages/rules/sections.tsx` 的 `perUpSectionsFor(sub, features)`。B 站全露；拓展按源报得出的特性露 —— 过滤（关键词 / 正则 / 白名单与四个类型开关都露，`FILTER_CONTENT_KEYS`；过滤吃 `Post`、对所有来源生效，ADR-0021 决策 43）与动态消息（报作品才露）、直播消息（报开播或下播才露）、消息版式与 AI 人格（都露）；「直播阈值」换成「推送时段」（免扰总露；报开播加重启补报，露「正在直播」时加状态推送间隔，报直播时加断流接续）。不露：动态图集（决策 72）、直播总结、上舰提示、特别关注、SC / 上舰阈值。存储上拓展订阅本来就有 `overrides` 这几格，只是页面按这张表列。
- **女仆查订阅**：`apps/server/src/ai/read-only-tools.ts` 的 `buildAiSubsView` 按订阅 `id` 为键收两支，停用的不进。B 站条目带 `uid`；拓展条目带平台名（`extensionPlatformLabel`：清单 `display.label` → 拓展名 → 拓展 id）与外部 id，工具那头据此不拿它去问 B 站。「女仆查直播状态」经 `LiveNowReader`（接线处叫 `liveNow`）对所有订阅都从在播表回答；来源没在跑时答「不知道」。

## 要改的时候

| 想干的事 | 动哪儿 / 注意什么 |
|---|---|
| 加一个平台 | **写一个订阅源拓展，BN 不动**（决策 65）。三条边界：契约只有通用的格（平台多出来的东西由 BN 加格、抬契约小号，拓展不能自己声明字段）；平台专属的玩法第一版不开（决策 5）；决策 64 列的那几样只属于 B 站 |
| 往契约里加东西（事件表一格、ctx 一个方法、一种积木、清单一格） | 改 `packages/internal` 的 zod + `packages/extension` 的手写镜像（shape-pin 会逼你两边一起改）；BN 发过版就抬 `EXTENSION_API_RANGE.revision`；更新契约形状守卫的摘要。漏了抬小号，老 BN 会照装新拓展、再把它报的东西整条拒掉 |
| 加一处要遍历所有订阅的地方 | **所有来源都处理**；只该认 B 站的就按 `subscriptionIdentityOf(sub).sourceKey === BILIBILI_SOURCE_KEY` 过滤并写一句为什么；绝不拿外部 id 去问 B 站 |
| 按身份找订阅 | 按 `identity` 两格比（`sameIdentity`），或两层 map、不拼串；「先认订阅 id、再认人、绝不跨来源」（`target-scope.ts` / `subscription-lookup.ts`） |
| 给订阅挂新的运行期数据 | 按订阅 id 存；高频写的别进配置（`config-changed "subscriptions"` 会整条重建），照 `SubscriptionStateStore` 另存；删订阅时的清理听 `subscription-changed` 的 remove |
| 改订阅的 schema | 新格要选填或带默认值；改了盘上的形状就抬迁移修订号（开发期）或在迁移器里加一步（发版后）—— 回退读的是旧的数据代，不再要求新旧载荷读同一个文件（ADR-0022） |
| 改拓展作品怎么推 | 入口在共用的 `PostQueue`（`posts/post-queue.ts`）、步骤在共用的 `deliverPost`、设置在共用的 `postSettingsOf`（都见 [push.md](./push.md)）；拓展这头只有绑定 `posts/extension-post.ts`、翻译 `posts/post-from-report.ts`、公共件 `runtime/extension-push-common.ts` —— 公共件拓展直播也要用，别写成作品专属 |
| 给来源接口加一个成员，或让核心多给来源一种待遇 | 进程内对拍（守卫 21b，`apps/server/src/__tests__/in-process-source-parity-e2e.test.ts`）会拦：成员表是 `as const satisfies Record<keyof 接口, …>`，加成员类型检查就红，必须来补一行指向管着它的对拍行。**加一行对拍**：在夹具 `apps/server/src/__tests__/support/in-process-source.ts` 的假来源上补这条能力（它只实现中立的 `Source`、键 `acme.inprocess`，夹具不许 import `bilibili/`）→ 在测试文件的 `PARITY_ROWS` 里加 `{ id, title, checked: true }`（id 接着 P20 往后排）→ 写一条按内容断言的用例，结尾调 `drove("Pxx")` → 把成员表里相关成员指向它 → 「清单自己」一组里写死的条数与 id 序列（总 38、对拍 20、不开 18）跟着改 → **验红**：真把核心里这条能力对应的那一处改坏跑一次，用例必须红，用例前写一句改坏的是哪处。**这能力今天拍不了**：在 `PARITY_ROWS` 里加一行 `checked: false`，写清 `waitsFor`（等哪一期）与 `reason`，条数自检跟着改。**把名单里的一行转成对拍**（标 3b 的行 3b 出期时要做）：该行改成 `checked: true`、去掉 `waitsFor` 与 `reason`、补用例。 |
| 让拓展订阅也走某个 B 站功能 | 先看决策 12 / 63 / 64 有没有定过；过滤（关键词 / 正则 / 白名单与四个类型开关）对所有平台一视同仁（ADR-0021 决策 43，取代了决策 70 里「类型开关只对 B 站」那半句） |
