# ADR-0021：1.0 中立核心 —— B 站退为内置来源，核心只认中立接口

- **状态**：2026-09-25 ～ 27 两轮 `/grill-me` 拍板（N1–N3、Q3–Q78、Q60b、命名批 29 条，以及 09-27 的字段名审查 R1–R5 / S1–S9 / M，一次一题）；2026-09-28 第三轮拷问补定（推送侧中立化、三路中立性审计查出的缺口、失败规矩与各模块，一次一题）：施工规矩是本份决策 58–60，其余分到 ADR-0024 ～ 0031。**未施工**；在 dev-next 上做，先发 1.0 alpha，稳定后升 1.0.0。
- **记录方式**：拷问当场落的定案，不是事后追认。细节的正本在 [docs/1.0/](../1.0/) 的施工参考（类型、目录树、迁移表、改名表）；本份只写定了什么、为什么、否了什么。
- **同批三份**：本份讲中立核心；[ADR-0022](0022-data-generations-and-migration.md) 讲数据代与迁移；[ADR-0023](0023-neutral-naming.md) 讲命名与改名。
- **影响面**：几乎全仓。
  - `packages/*`：internal、push、image、ai、storage、subscription、ui、extension，新增 http。
  - `apps/server`：目录重组、`bilibili/`、`compose.ts`、迁移模块、数据代。
  - `apps/contract`。
  - `apps/web`：按 descriptor 渲染、账号、预览、日志。
  - `extensions/bridge`：契约 v3、假桥搬家。
  - `docs/agents/*`。
- **依赖**：[ADR-0019](0019-subscription-source-opening.md)（订阅源的口）、[ADR-0020](0020-stats-cover-extension-subscriptions.md)（统计按「谁」认人）、[ADR-0012](0012-extensions.md)、[ADR-0013](0013-extension-marketplace.md)、[ADR-0008](0008-devtools.md)。
- **取代 / 修订**：见「取代与修订的旧条款」一节。

## 背景

ADR-0019 把订阅这口开给拓展时，定了「中立指结构，不改名」（决策 3、65）：推送链做成中立的，但名字、字段、特性键都保留 B 站口味，由拓展去适应。做完 ④–⑦ 回头看，代价比预期大：

- **核心里仍到处是 B 站的概念**：
  - `up`、`dynamic`、`guard`、`fans` 这些名字；
  - B 站独有的后门：核心直接读 B 站的 cron，健康页吐 B 站引擎的状态，面板写死 `isBili` 分叉；
  - 拓展的作品要先套进 B 站的动态类型才能出卡。
- **同一件事常有两条路**，B 站一条、拓展一条：粉丝时序、直播场次、头像、问题上报、「那天有没有在看」。
- **盘上格式为「能回退到旧载荷」付了很多代价**：订阅分两个文件，B 站行剥掉 `kind`，老行读的时候再翻译。

1.0 是一次破坏性大版本，正好把这些一次还清。

## 判据

- **这次重构的第一目标是平台中立。**
- **三等公民**：
  - **一等是中立核心**：名字、类型、数据形状、文档都不带平台味。
  - **二等是 B 站**：由我们内置，住服务端 `bilibili/`，直接实现 `SubscriptionSource`。
  - **2.5 等是拓展**：只从 `@bilibili-notify/extension` 这扇窄门进，由宿主经契约转成 `SubscriptionSource`。
- **所有平台都经 `SubscriptionSource` 接入核心**。让 B 站也去实现它有两个目的：
  - 把各平台的能力统一到同一个接口上；
  - 清掉 B 站现有那些不符合中立性的后门。
- **中立接口族是全集，拓展契约目前是它的子集**。中立接口族指 `SubscriptionSource` 加上拆出的横切接口（决策 8）。
- **越界判据只有一条**：核心里出现「B 站」这个概念，就算越界。B 站的东西要么搬回 `bilibili/`，要么变成核心的中立概念、由 B 站去实现。
- **没有后门**：B 站与拓展一样，只经中立接口进核心。B 站直接实现，拓展由宿主转一道。两边的区别只在谁写、住在哪、开放多宽。
- **方向原则**：「发生了什么」用事件，也就是来源向核心上报；「帮我做什么并给结果」用接口调用，也就是核心调来源。
- **包判据**：中立的代码进 `packages/`，B 站与宿主装配进服务端。

## 决策

### 分层与装配

1. **B 站四个包（api、blive、dynamic、live）搬进 `apps/server/src/bilibili/`，包删掉**。它们的中立部分进服务端的 `posts/` 与 `live/`。其余中立包（push、subscription、storage、image、ai）都留在 `packages/`（Q57，改写 Q22「只剩一个使用方就搬回服务端」的判据）。
   - 理由：`packages/` 物理上 import 不到 `bilibili/`，中立性由目录结构直接守住。
2. **服务端按功能分目录（Q3），组装根是 `compose.ts`（Q42）**。只有 `compose.ts` 能 import `bilibili/`，由它登记 B 站的各接口实现与拓展宿主；`index.ts` 只管启动。
3. **中立装配留在服务端，不开装配包（Q22）**。作品装配在 `posts/`，直播装配与直播附加项的生产在 `live/`。
4. **共享件怎么归位（Q14b）**：
   - 两个及以上使用方的纯逻辑进 internal 零依赖子路径；
   - wire 形状进 contract；
   - 纯展示组件进 ui；
   - B 站专属的进 `bilibili/`；
   - 持久化底层进 storage。

   扫出来的重复全部在 1.0 施工里处理。
5. **核心账号模块叫 `accounts/`**，管「系统 → 账号」、账号排序、汇总各来源的登录态。B 站的登录系统进 `bilibili/auth/`。

### 方向原则与接口族

6. **来源 → 核心一律是上报事件，核心 → 来源一律是接口调用**（Q67 讨论中定）。
   - 理由：把「请求 / 回应」改成事件，就要手工重造函数调用本来自带的东西：对上号、超时、取消、报错、类型检查。拓展没实现某个请求时，事件只能干等到超时；接口在登记的那一刻就知道它有没有。
   - 拓展的事件由宿主转进 MessageBus。拓展拿不到总线本身，所以伪造不了核心事件。
7. **`SubscriptionSource` 只管「订阅一个人」这件事（Q26、Q61；09-27 S8、S9 修订）**，共 10 个成员：
   - 声明型：`descriptor`；
   - 必备：`start` / `stop`、`searchCreators`、`fetchProfile`；
   - 可选：`auth`、`fetchLiveStatus`、`liveInteractions`、`health`、`fetchPreview`。

   搜人只有一个方法 `searchCreators`，沿用拓展「解析门」的语义：输入框里是链接、id 还是名字都原样交进来，来源自己认（B 站：纯数字按 UID 精确查、主页链接先抽 UID、其余按名字搜），最多回 10 个候选 `CreatorCandidate = CreatorProfileReport & { externalId }`。按 id 取人就是 `fetchProfile`，原先设计的 `lookupCreator` 与它重复，删掉。核心的 `/api/subs/search` 与 `/api/subs/lookup` 合成 `GET /api/sources/:sourceKey/creators?q=`，B 站搜人的后门关上。原先的「新建 / 启用订阅」钩子 `onSubscriptionAdded(sub)`（一度改名 `onSubscriptionActivated`）删掉：它和 ctx 的 `onSubscriptionsChanged` 重复（S9）。来源要在订阅变化时做事，一律用 `onSubscriptionsChanged` 自己对比新旧名单（决策 56）。`status()` 改名 `health()`，免得和登录状态、直播状态撞词。
    🔗 **2026-09-28**：`searchCreators` 改成返回结果形状，失败不再靠抛；`health()` 只交一行字 `{ summary }`（ADR-0025 决策 12、ADR-0026 决策 4）。
8. **与订阅无关的能力拆成横切接口（Q61）**：`LinkResolver`、`CommandProvider`、`AiToolProvider`，再加上 `DevtoolsProvider`（Q52）与 `PushOutlet`（Q43）。
   - 理由：只做链接解析的拓展，不该被迫去实现订阅源；契约的 `contributes` 本来就是按键分开声明的。
    🔗 **2026-09-28**：推送侧那个口叫 `PlatformAdapter`（ADR-0024 决策 2）；`CommandProvider` 1.0 不造，`login` 改成核心的通用指令（ADR-0031 决策 1）。
9. **每种接口一张登记表，全都建在现有的 `createClaimTable` 上**：
   - 表加一个 `entries()`，用来列出全部；
   - 键就是 `"bilibili"` 或拓展 id，不加前缀（09-27 S1）；分派读 `identity.sourceKey`；
   - B 站在 `compose.ts` 里逐个 `claim`；拓展按清单 `contributes` 的各个键，由宿主转换后登记；
   - 拓展停用、卸载时撤掉自己那一行，不用重启。

   理由：原先按订阅 `kind` 分派认不出是哪个拓展，所以一度给拓展的键加 `ext:` 前缀；身份摊平（决策 14）以后分派直接读 `sourceKey`。前缀只是为了防拓展 id 恰好叫 `bilibili`，而不带点的 id 本就只留给官方源（ADR-0013），再把 `bilibili` 列为保留 id（`ExtensionIdSchema` 拒收），手动放进目录的拓展也撞不上，前缀就不需要了。
10. **来源用 `descriptor` 做自我介绍（Q61、Q74、Q10；09-27 S5 修订）**：字段有 `label`、`shortLabel`、`color`、`postNoun`、`creatorNoun`、`searchPlaceholder`、`supportedFeatures`、`supportedExtras`、`membershipPrograms`。「支持哪些」加 `supported` 前缀，和订阅上表示「开没开」的 `features` 分开。拓展清单的 `contributes.subscription` 直接写这些同名字段，删掉 `display` 那一层与 `events`，宿主的对照表 `SUBSCRIPTION_EVENT_FEATURES` 删掉。面板、锐评、模板都只读它，所有 `isBili` 分叉删掉。B 站那一行的平台徽章，只在装了第二个订阅源时才画。
    🔗 **2026-09-28 ADR-0027**：描述符加 `externalIdNoun?`（决策 5）、`icon?` 与 `featureHints?`（决策 6）。
    🔗 **2026-09-29**：`searchPlaceholder` 删掉，换成 `searchAccepts?: ("id" | "link" | "name")[]`：来源只声明搜人输入框收哪几种输入，提示句由 contract 的叫法函数拼（id 用 `externalIdNoun`，B 站三种都收，拼成「UID、主页链接或名字」），不声明就是「搜索{creatorNoun}」。描述符里的自由文字仍只有 `featureHints` 一格（ADR-0027 决策 6）。
11. **资料刷新由核心定时拉取（Q54）**：
    - 核心按「资料刷新间隔」调 `fetchProfile`，这个间隔从 `fansCron` 迁来；
    - 对同一来源串行调用，防风控的间隔由来源自己管，B 站的 200ms 留在 `bilibili/`；
    - 来源主动上报的资料，按同一个间隔限制密度；
    - 粉丝轮询并进这项必备能力，不另占能力位（修正 Q42「粉丝轮询走报资料」）；
    - 动态轮询不在此列：B 站拉的是整条关注流，没法按订阅逐个拉。
12. **卡片预览（Q65）**：
    - 预览请求带 `subscriptionId`，删掉裸 uid、房间号输入框；
    - 可选能力 `fetchPreview` 返回一条真实的作品或直播输入，来源没实现就用示例数据；
    - SC、上舰卡的付款人取该来源的 `auth.account()`；
    - 「按 UP 覆盖」对所有订阅开放。
13. **AI 工具（Q57、Q68）**：
    - `packages/ai` 删掉对 B 站包的 import；
    - 核心提供中立的只读工具：`list_subscriptions`、`get_creator_profile`、`get_creator_posts`、`get_live_status`、`search_creators`；
    - 6 个内置女仆技能改用这些工具，留在核心，天然支持所有来源；
    - 来源专有的工具与技能经 `AiToolProvider`（`readOnly` / `chat` / `skills`）登记；
    - 缺工具的技能在面板上自动隐藏；
    - 删掉面板里 3 条找不到对应工具的死标签。

### 身份与订阅

14. **订阅身份摊平成 `{ sourceKey, externalId }`（09-27 S1，修订 Q4 的判别联合），取身份的函数叫 `subscriptionIdentityOf`**。`SourceKey = "bilibili" | 拓展 id`；B 站的 uid 就当 `externalId`，中立层不再出现 `uid`。判重看这两格是否都相等。盘上也按这个形状存，「盘上平铺、读时映射」被 Q30 推翻。`sourceKeyOf` 退化成读字段；`SubscriptionKind` / `isBiliSubscription` / `isExtensionSubscription` 删掉。
15. **订阅合成一个文件、一次原子写；备份里订阅也只留一节，备份 schema 抬版（Q55）**。同一个 uid 的重复订阅，照旧分发给每一条。
    - 理由：当初分成两个文件，是为了回退到旧载荷时旧版读到的是自己的格式。有了数据代（ADR-0022 决策 1），回退读的是旧代，这个理由没了。
16. **显示名只有一条链，别名退役（Q8）；运行期状态只留资料缓存与问题表（Q19；09-27 S3、S6）**。问题表 `problems` 按 code 做键、多条并存（原先单数的 `problem` 装不下）；运行态统一叫 State：`SubscriptionStateStore` / `SubscriptionState` / `subscription-state.json`。
    🔗 **2026-09-28**：问题表不再存进订阅运行态，改成全在内存的一张表（ADR-0025 决策 11）；运行态只留资料缓存。
17. **特别关注的名单 `specialUsers { id, note? }[]` 进公共的订阅形状**。露不露这个设置，看 `descriptor.supportedFeatures` 有没有声明特别弹幕或特别进场（Q69，推翻 Q41「只挂在 B 站订阅上」）。
18. **补关注在登录失效时跳过，停用的订阅不补（Q14）**。关注同步是 BN → B 站单向（订阅了谁就补关注谁，因为动态从关注流里拉），全在 B 站内部（决策 56）：在 `onSubscriptionsChanged` 回调、开机、重新登录后各跑一次，整份名单先批量查关系、只补缺的（稳态写请求为零），失败按决策 47 报 `follow_failed`（09-27 S9）。停用的订阅不在名单里，自然不补。

### 作品与直播数据模型

19. **渲染器只认中立的 `Post`（N1）**，拓展作品不再套 B 站的动态类型。附加块只有 card、video、goods 三种中立数据，不开登记口（Q23，撤回 N1 ⑤）。
20. **图集与文章配图分开（Q36）**：`Post.images` 是图集；`article?: { title; images? }` 只有文章才有；`blockImages` 就是屏蔽图集。
21. **被转发的原作品叫 `repost`，OneBot 的合并转发叫 `mergeForward`，单张图只有一种类型 `PostImage`（Q39）**。
22. **来源抓好图，交给 BN 的是引用（Q63、Q78）**：
    - 核心在 `SourceContext` 上提供 `fetchImage(url, { headers?, signal? })`，负责拦内网地址、单张 8MB 上限、嗅探格式、超时，按 sha256 存进图库，返回 `ImageRef`；
    - 手里已经是字节的图（本地生成的扫码二维码，B 站也用；要来源自带客户端才抓得到的签名、TLS 指纹、POST 图；接口内嵌的 base64）走 `storeImage(bytes, { signal? })`，同一套格式嗅探与 8MB 上限，存进同一图库；
    - 上报一律只收 `ImageRef`，契约 v3 里不再出现 `Uint8Array`；
    - `PostImage` 是 `{ ref?, url?, width?, height?, isAnimated? }`：出卡只认 `ref`，`url` 只用于「查看原图」；
    - 出图器不联网；
    - B 站的缩放后缀与 Referer 留在 `bilibili/`，核心删掉 B 站域名白名单。

    理由：缓存与防护只在核心留一份，拓展不用各自写一套下载；所有来源交给 BN 的都是同一种形状。

    代价：交作品时就抓图，被过滤掉的作品，它的图也白抓了。抓失败时由来源决定是跳过，还是只给 `url`（卡片上显示占位）。
    🔗 **2026-09-28**：`fetchImage` / `storeImage` 返回结果形状；`fetchImage` 走集成自己的请求客户端，每一跳重定向都查（ADR-0025 决策 8、10）。
23. **头像也走 `fetchImage`（Q75，修正 Q62）**：资料里的 `avatar` 是 `ImageRef`，B 站图链没变就不重抓。作品图、直播封面、头像、历史快照都引用同一个图库，图库的位置与清扫规则见 ADR-0022 决策 9。面板一律走同源地址，删掉 `no-referrer` 绕行。
24. **数字、时间和「不知道」（Q5、Q6、Q7、Q9）**：
    - 人数传精确数，缺了就不写这个键；
    - 时刻是 ISO 字符串、以 `…At` 结尾，时长的名字带单位；
    - 计数全程是数字，只在出口由 `formatCount` 排一次版；
    - 时长的格式化只有一份 `formatDuration(start, end)`。
25. **字段改成中立名（Q40）**：`description`、`category`、`currentViewers` / `totalViewers`、`bio`、`isPremium`、`amount` + `currency`、`followers`、`followersDelta`；`danmaku` 不改。`Post.video` 表示作品本身就是视频，不设视频级的互动数。
26. **会员按「体系 + 档」建模（Q37）**：
    - 来源声明体系 `{ id, name, tiers | "custom" }`，每一档带 `rank`，1 是最低；
    - 事件带体系与档，可选带开通方式、月数、赠送、金额；
    - 推送阈值改成按体系设的 `minRank`；
    - B 站的体系叫 `guard`，它等级倒序的换算只在 `bilibili/` 里做。

    理由：调研了虎牙、斗鱼、快手、YouTube、Twitch、Kick，会员普遍是「体系 + 档」，只是档数与名字各不相同。
27. **周期推送的「正在直播」由核心计时，调 `fetchLiveStatus` 拿三种结果（Q35、Q53）**：
    - 在播：带着数据，推卡；
    - 已下播：走和下播同一条路，包括断流宽限与私聊提示，这就补上了漏收下播的兜底；
    - 拿不到：跳过这一轮，记一条问题，不再停止监听。

    计时按每一场的开播时刻各自起算，不全局同时拉。拓展停用时，用 `signal` 取消还在进行的调用。
28. **直播场次引擎合成一套（Q58）**：
    - 拓展那套场次引擎本身已经是中立的，去掉前缀，升格为核心的 `live/`；
    - 输入有两种：推送式的 `LiveSignal`（开播、状态、下播，B 站把弹幕通道翻译成这三种），和拉取式的 `fetchLiveStatus`；
    - 重启以后，核心逐个调 `fetchLiveStatus` 重建场次；
    - `room-session-base` 删掉；
    - 场次身份照旧按开播时刻认，`current` 与 `isLive` 的语义原样保住。

    验收：先在旧引擎上用端到端测试钉住开播、下播、断流接续、漏收下播兜底四种行为，再换成新引擎跑同一组测试。
29. **重启后的补推挂在 `liveStart` 下（`catchUpOnBoot`），`liveStreaming` 只管周期复推（Q21）**。

### 特性键与皮肤字段

30. **特性与卡种全用中立名，由核心登记（N3）**：
    - 推送种类与特性键同名；
    - 直播拆成 `liveStart`、`liveStreaming`、`liveEnd` 三把键（Q17，推翻 N3 的「live 不变」）；
    - `liveGuardBuy` 改为 `membership`；
    - 醒目留言、会员、特别弹幕、特别进场、词云、直播总结都是核心的中立特性，只是现在只有 B 站填数据。
31. **皮肤字段跟 `Post` 一一对应（N2）**：
    - 字段装的就是名字说的东西，跨卡种同义（Q38）；
    - 排好版的文字不以 `…At` 结尾；
    - `up.*`、`master.*` 统一为 `creator.*`（ADR-0023 决策 1）。
32. **老卡片皮肤不适配（Q31）**：皮肤包的 schemaVersion 抬版，旧包拒收，卡片只用按 1.0 契约新生成的皮肤。迁移时怎么处理指向老皮肤的指针，见 ADR-0022 决策 12。
33. **文案模板（Q10、Q11、Q11b）**：模板加 `{noun}`，取自 `descriptor.postNoun`；直播文案里的 `-key` 迁成 `{key}`，全仓只用一个模板引擎；人名变量统一为 `{name}` / `{viewer}`。
    🔗 **2026-09-28**：变量改叫 `{postNoun}`，与提示词变量同名；`{noun}` 从没上过盘，直接改名、不用迁移；默认文案「{name}发布了一条{postNoun}」保留「一条」（ADR-0028 决策 3）。
34. **静音与免打扰只管推送（Q20）**：被挡下的目标落一行 `silenced`、存下重推原件；它不算推送，也不算失败，补发闸会放行它。
35. **「UP主」这个叫法由来源给（Q74）**：
    - `descriptor.creatorNoun`：B 站是「UP主」，拓展自己报，缺省叫「创作者」；
    - 只涉及一个来源的地方，用它的叫法；混着多个来源的地方，用「创作者」；
    - 只装了 B 站时，混合的地方也用 B 站的叫法。

### 拓展契约 v3 与开放范围

36. **契约抬到 v3，最低版本也是 3，删掉 v1、v2 的退路（Q44）**。桥与 1.0 同批迁到 v3。
37. **v3 的过渡（Q51）**：
    - 市场的 `pickPerId` 改成「在当前 BN 装得了的版本里取最高」；
    - 索引规则从「每个 id 一条正式、一条预发布」放宽为「每个契约版本各留最新一条」，这样 0.12 仍拿得到 v2 的桥；
    - 1.0 alpha 期间，v3 的桥只进预发布档；
    - 升级后第一次打开面板时的询问页，列出「因契约版本不收」的拓展，给一个一键更新；不在开机时静默替换。
38. **1.0 对拓展只开放这些（Q76、Q77）**：
    - `contributes`：`subscription`、`push`、`devtools`；
    - `ctx`：`subscriptions`（改形状，决策 56）、`fetchImage`、`storeImage`、`state`、`secrets`、`redact`、`reportProblem` / `resolveProblem`。
    - 拓展的 `supportedFeatures` 只能声明 `post`、`liveStart`、`liveStreaming`、`liveEnd`；声明了 `liveStreaming` 就必须实现 `fetchLiveStatus`。宿主装载时校验，不合规就拒收并说明原因（09-27 S5）。
    - 契约里拓展的 `lookup` / `lookupPlaceholder` 改名 `searchCreators` / `searchPlaceholder`（09-27 S8）。
      🔗 **2026-09-29**：`searchPlaceholder` 又换成声明式的 `searchAccepts`，见决策 10 下的 🔗。

    `linkResolver`、`commands`、`aiTools` 暂不对拓展开放：核心的接口与登记表照做，B 站照用，等写抖音拓展时再定。以后加进来，只是清单里多几个可选键，不用抬大版本。
    🔗 **2026-09-28**：ctx 改成 `IntegrationContext` 加各自特有的一层，新增 `http`、`settings`；上报类改成 `void`，被拒记进 `reportRejections`（ADR-0025 决策 1、6、10）。
    🔗 **2026-09-28**：`commands` 那张登记表 1.0 不造（ADR-0031 决策 1）；`linkResolver`、`aiTools` 照原句。
    🔗 **2026-09-28**：清单不收 `membershipPrograms` 与 `supportedExtras`：1.0 的拓展声明不了会员与直播互动类特性，这两格填了也用不上。
39. **来源的运行状态由宿主托管，接口是 `ctx.state`（Q77，撤回 Q70 的 `ctx.dataDir`）**：
    - 三个方法：`get`、`set`、`delete`，值是 JSON；
    - 上限：单个键 64KB，总共 1MB；
    - 宿主负责原子写，存到 `runtime/bilibili/state.json` 或 `runtime/extensions/<id>/state.json`；
    - 跟着数据代走，不进备份；卸载拓展和全新开始时一起清掉。

    理由：宿主已经托管了订阅、上报、设置、凭据，只差运行状态这一格（游标、分页令牌、小索引）。补上以后，来源的所有持久状态都由宿主落盘，ADR-0012 决策 14 完整保留，并且延伸到这一格。
40. **`ctx.secrets` 在 1.0 开放（Q66）**：用主密钥加密，存在 `secrets/bilibili/` 或 `secrets/extensions/<id>/`；仅完整备份（普通备份抹掉）；卸载时清掉。
    - 理由：拓展的登录要接进系统账号（决策 45），凭据得有地方放。
    🔗 **2026-09-28**：`secrets` 与 `state` 是同一个 `KeyValueStore` 接口；一个集成一个文件，按值脱敏，`http.` 前缀归宿主（ADR-0025 决策 9）。
41. **来源不读写文件（Q77）**：
    - **B 站**：和拓展用同一个 `SourceContext`。cookie 走 `ctx.secrets`；`roomId`、`followed`、`followError` 搬出核心的订阅运行态，放进 B 站自己的 `ctx.state`。`bilibili/` 下 import `fs`，门禁判红，守卫写法同 `extension-import-boundary.test.ts`。
    - **拓展**：「不读写文件」写进契约；官方市场发布时做静态检查，打包产物 import 了 `fs` 就不收；手动安装的第三方拓展在安装时警告。
    - **真正的强制要靠沙箱**：拓展与 BN 在同一个进程里，现在拦不住，见「以后再说」。

### 配置与密钥

42. **设置用单文件分段 `config/settings.json`，分 `core`、`bilibili`、`extensions.<id>` 三类段（Q60b、Q25）**：
    - 每段的 schema 由归属方定义，核心负责组合；
    - 拓展段校验失败，只停用那一个拓展，BN 照常开机；
    - 卸载拓展时删掉它那一段；
    - 守卫禁止核心代码读 `bilibili` 段。

    理由：拓展是给 BN 加功能的，它的设置本来就是 BN 的设置；现有的原子写和写入队列版本号，都是按「单文件 + 一条队列」写好的。
    🔗 **2026-09-28 改成只停那一处**：拓展段与 `bilibili` 段坏了只停那个集成；`core` 段逐格退回默认并记问题；只有信封坏了才挡开机（ADR-0025 决策 4）。
43. **核心配置去掉 B 站的形状（Q25）**：
    - 过滤看 `Post` 上「有没有」某样东西，放在装配第一步，对所有来源生效；
    - SC 阈值按人民币算，别的币种先放行；
    - 特别关注去掉 uid 正则；
    - 卡片时间读全局时区，默认 Asia/Shanghai。
44. **凭据字段在 schema 上标 `secret: true`（Q56、Q12）**：
    - 面板打码（`MaskedSecret`：固定 8 个点，≥24 字符才露出头尾各 4 位）与备份脱敏都读这个标记，不再各自按键名猜；
    - webhook 的 `url` 算凭据，因为飞书、钉钉的 token 就在路径里；OneBot 的地址照常显示；
    - 备份脱敏照旧把两类都抹掉。

### 面板、账号、问题上报与日志

45. **登录是一个中立的状态机（Q66）**：
    - `SourceAuth { methods, beginLogin, logout, state, account? }`；
    - `AuthState` 有这几种：`logged-out`、`awaiting-scan`（带二维码）、`scanned`、`logged-in`、`expired` / `error`（状态值 kebab）；
    - 原先设计的 `SourceAuth.secrets { export, import, redactPatterns }` 整块删掉（09-27 S4）：凭据的备份与恢复全归宿主托管的 `ctx.secrets`，来源不再自己导入导出，它和 `ctx.secrets` 同名、看着像一回事也是问题；
    - 面板的扫码登录只写一套，拓展的登录直接接进「系统 → 账号」；
    - 拓展积木 `qrLogin` 退役，它从来没实现过。
46. **头部显示哪个账号，由主人在「系统 → 账号」里拖动排序决定（Q66）**：
    - 顺序存进核心配置，进备份；
    - 默认按登记顺序，B 站在前，新来源追加在末尾；
    - 排第一的显示在头部，其余的在小三角下拉里；
    - AI 对话里主人的头像和头部一致；
    - 新手引导的登录步，由声明了 `auth` 的来源生成。
47. **问题上报是事件（Q67；09-27 S3 定写法）**：
    - `ctx.reportProblem({ externalId?, code, message, notify?: boolean })`；
    - `ctx.resolveProblem({ externalId?, code })`。

    严重度、文案、要不要打扰主人，全由来源决定：问题一律进面板问题框，`notify: true` 再私聊主人。不填 `externalId` 是来源本身的问题；填了由核心展开到订阅，按 code 存进 `problems`（`since` 记第一次出现，重复报只更新文案）。code 用 snake。核心只守一条底线：同一来源、同一 code 的私聊，60 秒内只发一次。核心收到每条问题都自动记一行日志；只想记日志就用 `ctx.logger`，两者不合并。B 站的「登录失效」也走这里。

    理由：原先的泛型 `report(kind)` 在一堆 `reportX` 里是孤例；`level: "panel" | "notify"` 的两个值其实是「发到哪」，不是严重程度；拓展详情页那个「上报被拒」的框改名 `reportRejections`，和来源自报的问题分开。
    🔗 **2026-09-28**：问题表的形状、生死规矩与推给面板的方式见 ADR-0025 决策 11；平台适配器也能报，带 `connectionId`。
48. **健康页与 status 指令按来源列（审查补扫）**：
    - 可选能力 `health()`（原 `status()`）交状态行；
    - 健康页返回 `sources[]` 加上核心各模块，删掉 `dynamicCron` 等没人读的字段；
    - 新建订阅的弹窗合成一套流程：选平台 → 搜索或候选 → 预填资料；
    - 面板调接口的代码只在 `services/` 写一次（Q18）；
    - 面板文件名全部用 kebab-case（Q15）。
    🔗 **2026-09-28**：健康卡分核心与集成两排，`health()` 只交一行字（ADR-0025 决策 12）。
49. **日志（Q73）**：
    - `ctx.logger` 把来源写进日志行已有的 `name` 字段（`bilibili` 或拓展 id），面板可以按来源筛选；
    - 按模块调级别改成开放的键：核心各模块，加上 `bilibili`、拓展 id；老的 `dynamic`、`live` 并成 `bilibili`；
    - 日志落盘前，按当前全部密钥的实际值脱敏，值来自 `ctx.secrets`、`secret: true` 字段，以及来源用 `ctx.redact(value)` 登记的临时凭据（09-27 S4）；`logs/redact.ts` 里写死的 B 站 cookie 名正则删掉；
    - 日志行格式不变。

### 统计

50. **统计记录全部作品，另外记其中带视频的那些（Q28）**；面板与 CSV 里仍叫「投稿」「动态」。
51. **「那天有没有在看」统一按 seen 判（Q64）**：
    - 核心每次成功联系到来源，包括拉资料成功、收到作品或直播信号，就给该订阅记当天一条 seen，B 站与拓展同一规则；
    - 热力图与「在记」标记只看 seen；
    - 在播状态与当前粉丝数，取在播表与资料缓存；
    - 迁移时从 B 站的老粉丝样本里，每天补一条 seen，老热力图显示不变。
    🔗 **2026-09-28 改成按特性分**：「在记」分作品、直播、粉丝各算，热力图也读它；seen 不再单独当判据（ADR-0027 决策 2）。

### 总线与横切

52. **总线只留按订阅 id 发的中立事件（Q24）**：来源只报 externalId，核心在进门那一刻按身份展开成订阅 id（决策 56；原先是 B 站自己把 uid 翻成订阅 id）；通过 WS 转给面板的也是中立事件；仍然只有一条总线。
53. **进程托管（Q13）**：宿主经 stdin 管道通知关停，由开关变量控制，并进现有的父进程看护；服务端的关停预算压到 8 秒；compose 样例写上 `stop_grace_period`。
54. **devtools 走 `DevtoolsProvider`（Q52）**：
    - B 站在 `bilibili/devtools/` 里实现，`compose.ts` 只在开发版里登记；
    - 构建时的换桩改成写死的两项目录表：`src/devtools/`、`src/bilibili/devtools/`；隔离测试认这两个引用点；
    - 拓展经 `contributes.devtools` 声明一个独立入口，宿主只在开发版里 `import()` 它；
    - 桥的假桥与场景搬进桥自己的开发入口，直接用桥自己的协议定义。

    理由：核心 devtools 里写死桥的协议帧，是核心为某一个拓展开的特例。搬过去以后，核心 devtools 不认识任何一家来源。
    🔗 **2026-09-28**：场景叫 `DevScenarioDef`，id 由宿主加前缀，参数按提供方收窄，`run` 返回结果形状（ADR-0031 决策 2）。
55. **全仓的包版本统一为 `0.0.0-dev`（Q16）**。

### 09-27 字段名专项审查补的结构决策

56. **来源只认人，不认订阅（09-27 S2）**：
    - 来源上报只带 `externalId`：`reportPost(externalId, PostReport)`、`reportLive(externalId, LiveSignalReport)`、`reportProfile(externalId, profile)`。`sourceKey` 由核心按 ctx 补，所以拓展冒充不了 B 站。
    - 核心按身份查订阅，正常只有一条（同一身份只能有一条订阅），老数据里遗留的重复各分一份，展开成每条订阅一份的 `PostEvent { subscriptionId, identity, postId, url, post, postNoun? }` / `LiveSignal`；查不到或已停用就丢弃、记 debug 日志。
    - 名单：沿用 `ctx.subscriptions()` 与 `onSubscriptionsChanged`，条目改成 `SourceSubscription { externalId, features }`：只列启用中的订阅、不带订阅 id，同一人的重复订阅合成一条、`features` 取并集。来源只上报名单里的人，开着哪些特性决定它干哪些活（没开直播就不连弹幕，没开作品就不拉也不抓图）。核心收到上报后兜底再查一次名单。
    - B 站也用这份名单，不再拿完整的订阅对象。
    - `reportSubscriptionsChanged` 删掉：它来自对 Q42「关注同步 = 订阅变更通知」的误读。仓里的关注同步是 BN → B 站单向，从来没有「平台那头关注列表变了反过来改 BN 订阅」的功能。
    - `PostEvent.id` 改名 `postId`。

    理由：订阅 id 是 BN 自己编的号，来源只认识平台上的人。让来源按订阅 id 上报，就得把内部编号告诉它、让它再维护一张对照表，而这张表核心本来就有。
    🔗 **2026-09-28**：按后缀表，这个从订阅现算给来源看的投影叫 `SourceSubscriptionView`（ADR-0023 决策 15）。
57. **主人通知只有一个口（09-27 命名审查）**：推送层的 `sendPrivateMsg` / `sendToMaster` / `sendErrorMsg` 合成 `notifyMaster(text)`；出口上的 `sendPrivate` 与「强制私聊」标志 `{ private: true }` 删掉，出口只有普通的 `send`。私聊的要求挪到选主人目标时：`master.targetId` 必须指向私聊目标（schema 校验，面板下拉只列私聊目标）；迁移时指向群目标的清空，首访页提示重选。
    - 理由：主人目标原先可以随便选；选了群目标，强制私聊会把群号当成 QQ 号去调「发私聊」，要么报错、要么错投；选的本来就是私聊目标时，这个标志又什么都不做。
    🔗 **2026-09-28**：`notifyMaster` 收文字或消息体、返回结果形状；发送时复检主人目标是私聊，把它改成群目标的 PATCH 拒收（ADR-0024 决策 14）。

### 09-28 第三轮拷问补定

起因：订阅侧已经是「B 站与拓展实现同一个接口」，推送侧还是两套。随后三路只读审计把「订阅进来 → 核心 → 推送出去」逐模块查了一遍中立性与守卫覆盖，查出一入一出都没有咽喉守卫、守卫 11 不扫 contract 与面板、`isBili` 的替身（`sourceKey === "bilibili"`、`"@bilibili"`）没有门拦，再逐题补缺口。按主题分到各自的 ADR：

| ADR | 讲什么 |
|---|---|
| [0024](0024-push-platform-adapter.md) | 推送侧：内置平台与拓展实现同一个 `PlatformAdapter`，只有 `TargetDispatcher` 能发送，投递失败归核心 |
| [0025](0025-integrations.md) | 集成：`IntegrationContext`、设置、`packages/http`、`state` / `secrets`、问题表、健康 |
| [0026](0026-failure-results.md) | 失败规矩：一次操作的结果形状与标准码 |
| [0027](0027-monitoring-stats-and-descriptor-driven-panel.md) | 开了开关才监听、统计按特性记、面板只从描述符拿来源信息 |
| [0028](0028-post-text-rendering-and-templates.md) | 作品文字的拼法、出图字节门、模板变量、醒目留言与会员卡 |
| [0029](0029-link-preview.md) | 链接预览 |
| [0030](0030-ai-follows-sources.md) | AI 跟着来源走 |
| [0031](0031-commands-and-devtools.md) | 指令与 devtools 场景 |

本份只留整个中立核心的施工规矩：

58. **不整体重写，以改造为主**：某个模块的核心逻辑从头到尾是 B 站的形状、改造要动每一行时，才对着中立接口局部重写，旧测试当规格书。
59. **中立性守卫补成三层**（表在 docs/1.0 的 architecture）：
    - 咽喉：入口（compose 里 `bilibili/` 的东西只能作登记的参数，核心里没有平台客户端）；出口（只有 `TargetDispatcher` 能发，全部发送路径的截流 e2e）；出图器零联网。
    - 静态扫描：B 站替身、守卫 11 修订（边界匹配、词表自动生成、扫 contract）、uid 棘轮、中文叫法棘轮、按 `.platform` 做决定的棘轮、推送词表加宽、事件载荷、类型名后缀（ADR-0023 决策 15）。
    - 对拍：契约层与进程内全量假来源两层、推送假适配器、模板变量可满足性、AI 工具与技能约束、守卫 10 扩到五种卡。
60. **归期**：第 2 期抽 `packages/http`（抓图服务建在它上面）；3a 平台适配器接口与登记表、内置适配器与模板候选、`/api/adapters`、连接与目标的新形状与迁移、`SourceContext` 的 `settings` 与 `http`、设置坏了只停那一处、推送守卫①与守卫②棘轮开；3b 契约 v3 推送侧加宽、桥迁 v3、守卫③；第 4 期面板按描述画（健康卡先出设计稿）；3b 结束时守卫②清零；第 6 期的抖音拓展是 `ctx.http` 的第一个拓展用户。

## 取代与修订的旧条款

落稿时，在每条旧条款的原文下挂一个 🔗，指到本份。名字相关的条款见 ADR-0023，数据与迁移相关的条款见 ADR-0022。

| 旧条款 | 现在 | 本份 |
|---|---|---|
| ADR-0019 决策 6「图交字节，SSRF 白名单不动」；「明确不做」里的「按来源放宽取图白名单」「ctx 给一个帮我取图的钩子」 | 推翻：改用 `ctx.fetchImage` 交引用，删掉白名单，防护改成拦内网地址。当年否掉钩子的两条理由都不再成立：`fetchImage` 由来源在交作品时调用、结果进图库，出卡时不回调拓展；请求头由来源自己传，BN 不用学平台的门道 | 22 |
| ADR-0019 决策 8「持久状态那一格这次不开」 | 修订：由宿主托管的 `ctx.state` 开出这一格；B 站的动态游标仍只在内存 | 39 |
| ADR-0019 决策 23「扫码登录 = qrLogin 积木 + 动作」；「仍未决」里「ctx.secrets 等第一个真要扫码的源」 | 推翻：登录走 `SourceAuth` 状态机与系统账号，qrLogin 退役；`ctx.secrets` 提前到 1.0 | 40、45 |
| ADR-0019 决策 47「盘上两个文件」、决策 48「备份里拓展订阅单独一节」 | 推翻：一个文件、一节 | 15 |
| ADR-0019 决策 64 子条「只属于 B 站的：…粉丝轮询」 | 推翻：粉丝经 `fetchProfile` 中立化；链接卡、指令、直播互动改为中立接口的可选能力 | 8、11 |
| ADR-0019 决策 67「B 站计时器不搬进中立层，BN 不开向拓展要最新状态的反向口子」 | 推翻：核心计时、调 `fetchLiveStatus`，场次引擎合一 | 27、28 |
| ADR-0019 决策 69「拓展作品套进 B 站的动态类型」 | 推翻（N1）：渲染器只认中立的 `Post` | 19 |
| ADR-0019 决策 70「过滤对拓展作品只认内容，类型开关一律不看」 | 推翻（Q25）：过滤看 `Post` 上「有没有」，对所有来源生效 | 43 |
| ADR-0019 决策 73「历史行加 `extensionId` / `externalId` 两格，`uid` 改选填」 | 修订：身份按 `{ sourceKey, externalId }` 存，B 站的 uid 就是 externalId | 14 |
| ADR-0019「明确不做」里「把所有订阅统一成（来源，来源 id）」「内部特性键换中立名」 | 推翻：1.0 是破坏性版本，由一次性迁移改写盘上的键，不留别名 | 14、30 |
| ADR-0020 决策 8「拓展粉丝来自资料上报，不密过 B 站的采样间隔」 | 推翻：核心统一的「资料刷新间隔」 | 11 |
| ADR-0020 决策 9「那天有没有记录各算各的，B 站那一行的规矩不变」 | 推翻：统一按 seen 判 | 51 |
| ADR-0016「明确不做」里「历史行解释『为什么没发』」 | 收窄：静音与免打扰挡下的目标落一行 `silenced` | 34 |
| ADR-0012 决策 14「持久状态由宿主落盘，备份天然带上」 | 保留并延伸：运行状态也由宿主经 `ctx.state` 落盘，来源不读写文件 | 39、41 |
| ADR-0012 决策 42「假桥住在核心 devtools，协议帧在核心手抄」 | 推翻：假桥搬进桥自己的开发入口，核心 devtools 不认识桥 | 54 |
| ADR-0013 决策 5 🔗「同一个 id 各留一条正式 + 一条预发布」 | 修订：每个契约版本各留最新一条，宿主取装得了的里面最高的 | 37 |
| ADR-0008 决策 4「构建只把 `src/devtools/` 换成空桩」 | 修订：换成写死的两项目录表 | 54 |
| ADR-0006 决策 3「链接卡拼成 `DYNAMIC_TYPE_AV` 喂渲染器」 | 修订：链接卡出中立的 `Post`（配置改名见 ADR-0023） | 19 |
| ADR-0014 决策 14「皮肤字段表只增不删不改名，老皮肤永远能画」 | 推翻：字段按中立名重排，老皮肤不适配 | 31、32 |
| 拷问中途：N1 ⑤ 卡种 / 附加块登记口 | 撤回（Q23） | 19 |
| 拷问中途：N3「live 不变」 | 拆成三把键（Q17） | 30 |
| 拷问中途：独立的装配包 | 撤回，中立装配留在服务端（Q22） | 3 |
| 拷问中途：Q22 判据「只剩一个使用方就搬回服务端」 | 改为「中立的进 packages/」（Q57） | 1 |
| 拷问中途：Q4「盘上平铺、读时映射」 | 推翻（Q30） | 14 |
| 拷问中途：Q35 的函数名与「返回空就跳过」 | 修正：`fetchLiveStatus` 三种结果（Q53） | 27 |
| 拷问中途：Q41「特别关注只挂在 B 站订阅上」 | 推翻（Q69） | 17 |
| 拷问中途：Q42 devtools 放在 `bilibili/devtools/`，漏了换桩 | 补上两项目录表（Q52） | 54 |
| 拷问中途：Q42「粉丝轮询走报资料」 | 修正：走 `fetchProfile`（Q54） | 11 |
| 拷问中途：Q62 头像交字节，存 `runtime/avatars/` | 修正：走 `fetchImage`，进统一图库（Q75） | 23 |
| 拷问中途：Q70 `ctx.dataDir` | 撤回：改为宿主托管的 `ctx.state`，来源不读写文件（Q77） | 39、41 |
| 拷问中途：Q4 订阅身份的判别联合、登记表键的 `ext:` 前缀 | 修订：摊平成 `{ sourceKey, externalId }`，键不加前缀，`bilibili` 为保留 id（09-27 S1） | 9、14 |
| 拷问中途：Q42「关注同步 = 订阅变更通知」被写成来源 → 核心的 `reportSubscriptionsChanged` | 删掉：关注同步是 BN → B 站单向，全归 B 站内部（09-27 S2） | 18、56 |
| 拷问中途：Q67 的 `report("problem" / "problem-resolved")` 与 `level` | 修订：`reportProblem` / `resolveProblem` 与 `notify?`（09-27 S3） | 47 |
| 拷问中途：审查补扫的 `SourceAuth.secrets { export, import, redactPatterns }` | 删掉：备份恢复归宿主，临时凭据用 `ctx.redact`（09-27 S4） | 45、49 |
| 拷问中途：接口拆分时的 `searchCreators` + `lookupCreator` 两个搜人方法 | 合成一个 `searchCreators`，按 id 取人用 `fetchProfile`（09-27 S8） | 7 |
| 拷问中途：接口拆分时的必备成员 `onSubscriptionAdded`（命名批改名 `onSubscriptionActivated`） | 删掉：与 `onSubscriptionsChanged` 重复（09-27 S9） | 7、18 |

## 明确不做

- **把 B 站做成一个内置拓展、走公开契约**（Q45）：B 站直接实现中立接口族，拓展经契约由宿主转一道。中立接口族是全集，拓展契约是子集。
- **让机器人框架当核心的宿主**：引擎层不给它们留钩子。以后要做完整插件，走「薄插件 + 插件托管一个 BN 进程 + 桥借 bot」这条路。托管的规矩（孤儿自检、stdin 关停、数据目录与端口、载荷选版）在 1.0 写成文档，作为施工项。
- **全靠事件通信**（Q67 讨论中定）：原因见决策 6。
- **问题上报设「只记日志」一档**（Q67）：只想记日志，就用 `ctx.logger`，两者不合并。
- **让来源知道订阅 id、按订阅 id 上报**（09-27 S2）：原因见决策 56。
- **登记表的键给拓展加 `ext:` 前缀**（09-27 S1）：原因见决策 9。
- **给拓展一个文件目录 `ctx.dataDir`**（Q70 → Q77）：宿主认不得的文件，拓展就得自己保证原子写，这正是 ADR-0012 决策 14 要避免的。
- **设置按归属拆成多个文件**（Q60b）：一次跨段保存要写好几个文件，得另造一套多文件事务，换来的只是手动翻文件更直观。另外，设置里不设 `sources.` 这一层，因为内置来源只会有 B 站一个。
- **会员高亮叫 `highlightName`**（Q40）：选定 `isPremium`。
- **BN 侧替来源判新、去重、限流**：维持 ADR-0019 决策 53。
- **extension 包的版本号对齐契约档位，再加一道守卫**（Q16）：拓展兼容看清单的 `apiVersion` 与 `EXTENSION_API_RANGE`，不看包版本；全仓包版本统一成 `0.0.0-dev`，`packages/extension` 也一样，等真要给第三方发 npm 那天再定。
- **devtools 换桩用 `**/devtools/**` 通配**（Q52）：这等于谁在哪开一个 devtools 目录都合法。
- **1.0 就把 devtools 换成 devframe、新手引导换成 driver.js**：1.0 之后各自立项，先做小试验再决定。
    🔗 **2026-09-27 改期**：提前到第一版 alpha 之后、1.0.0 之前；仍各自先做小试验再定（见 docs/1.0 的 construction-plan）。
- **整体重写**（09-28）：按决策 58 的判据逐模块局部重写。

## 后果

- **施工面极大**：几乎每个包都要动。原本按「④′ 轮」估 12–14 轮，第二轮拷问又加了数据代、接口拆分和命名批，总量施工时再重估，不含真机验收。
- **拓展要重发**：契约 v3 不兼容 v2，桥与 1.0 同批迁移；第三方拓展重发之前装不上 1.0。
- **交作品时就抓图**：被过滤掉的作品，它的图也已经抓过了。
- **老卡片皮肤作废**：用户做过的卡片皮肤要按新契约重新生成。
- **「来源不读写文件」对拓展暂时只是规矩**：真正拦住要等沙箱。在那之前，靠官方市场的静态检查和安装时的警告。

## 以后再说

- **`linkResolver`、`commands`、`aiTools` 对拓展开不开放**：等写 alpha 配套的抖音拓展时再定。
- **拓展沙箱**：用 SES 的 `lockdown` 加每个拓展一个 `Compartment`，把「不读写文件」和「拿不到密钥」变成真正的强制。先做兼容性 spike。
- **施工时再定**（不影响架构，对着代码更好定）：`engine-error` 的中立模块名；直播互动走能力回调还是走总线；现有 22 个总线事件的全量去向表。
- **进程托管协议文档**：1.0 的施工项；插件本身住各自的独立仓，真开始做时再定。

## 施工时要同步的文档

- `CLAUDE.md` 与 `docs/agents/*.md`（push、architecture、commands、events、devtools、self-update、extension-marketplace）里的过时引用，随施工第 5 期同步。
