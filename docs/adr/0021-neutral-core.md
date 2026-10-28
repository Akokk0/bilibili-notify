# ADR-0021：1.0 中立核心 —— B 站退为内置来源，核心只认中立接口

- **状态**：2026-09-25 ～ 27 两轮 `/grill-me` 拍板（N1–N3、Q3–Q78、Q60b、命名批 29 条，以及 09-27 的字段名审查 R1–R5 / S1–S9 / M，一次一题）；2026-09-28 第三轮拷问补定（推送侧中立化、三路中立性审计查出的缺口、失败规矩与各模块，一次一题）：施工规矩是本份决策 58–60，其余分到 ADR-0024 ～ 0031。**第 2 期 / 3a / 3b 已落一部分**，现状见各决策下的 🔗；余下归第 4、5 期；先发 1.0 alpha，稳定后升 1.0.0。
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
   🔗 **2026-10-05**（㉓ 开片拷问，主人拍板）：`blive` 不单开子目录，搬家时直接并进 `bilibili/live/`。它只是直播那一侧的协议层，分成两处没有必要。现在不合：出图器依赖 `blive`、直播引擎依赖出图器，合包会成环；㉓ 做完出图器就不再依赖它。被否的备选：第 2 期先合成一个包（同一批文件到 3a 再搬一回）。
   🔗 **2026-10-07**（3a-24 搬完之后主人看了目录，拍板）：并进 `bilibili/live/` 没变，但不平铺。`live/` 里按依赖分三层子目录：`protocol/`（弹幕连接的协议层，原 `blive`）、`session/`（房间会话与引擎）、`recap/`（下播后的回顾：攒弹幕、出词云、请 AI 写总结的那一套）；翻译函数、徽章图标与以后要搬去核心的三个中立文件留在 `live/` 根上。上一条防的是 `blive` 与 `live` 成两个平级目录，照字面平铺的结果是 30 个文件挤在一层。
2. **服务端按功能分目录（Q3），组装根是 `compose.ts`（Q42）**。只有 `compose.ts` 能 import `bilibili/`，由它登记 B 站的各接口实现与拓展宿主；`index.ts` 只管启动。
   🔗 **2026-10-11**（3a-28，主人定）：`compose.ts` 提前到 3a-28 建（原定 3a-40）。起因：1.0 的目的就是去掉入口里这批 B 站替身，3a-28 若不建它，入口的替身棘轮要先涨（原方案是 8 → 15）；勘察没读到任何必须等 3a-40 的技术前提。这一片它做两件事：造 B 站来源并直接往来源登记表登记（登记即 `start`）、认领 B 站那组开发场景；入口只剩调它的几行（替身数 8 → 5，不涨），它进 B 站替身守卫的白名单。「内置集成在 `start(ctx)` 里用同一组登记方法登记」这个终点这一片**没做**，仍留给 3a-40，连同三个内置适配器的造与登记、B 站设置的登记、登录装配、链接解析器与 AI 工具的登记、删 `engines.api`。「`compose.ts` 只放登记」这条在入口咽喉守卫（3a-40）开张前没有守卫钉着，靠审查。被否：不提前建、入口替身数先涨再降；让 `compose.ts` 交出一个不带 B 站名字的函数来躲计数。
   🔗 **2026-10-12**（3a-40 落成）：上一条里「仍留给 3a-40」的几项，做掉的：三个内置适配器的造与登记（10-11，第一块）、B 站设置的登记（`compose.ts` 导出 `BUILTIN_INTEGRATION_SETTINGS`，入口交给运行时）、舰长图标的建造；入口咽喉守卫开张（`scripts/__tests__/entry-throat.test.mjs`）：`compose.ts` 的出口（导出类型、值只能被调用或作实参、交回入口的 B 站那一格只许少）与核心里叫 `api` 的槽位都钉着。**没做的**：登录装配（主人 10-12 定留到 3b，随 `Api` 的读者消失一起进集成的 `start`；被否：这一片搬）、删 `engines.api`（主人 10-11 定这一片不删，入口咽喉守卫钉住读者名单只降不涨）、链接解析器与 AI 工具的登记、「在 `start(ctx)` 里用同一组登记方法登记」这个终点（登记表 3b 才有）。「`compose.ts` 只放登记」那条现在是：出口由守卫钉着，里面长没长登记以外的逻辑仍靠审查。🔗 现状（4-16，10-28）：交回入口的 B 站那一格整个删了（4-03 删 `fetchImage`、4-16 删 `api`），核心里叫 `api` 的槽位清零；`compose.ts` 交回入口的只剩登记与开发场景的几个方法。
3. **中立装配留在服务端，不开装配包（Q22）**。作品装配在 `posts/`，直播装配与直播附加项的生产在 `live/`。
   🔗 **2026-10-12**（3a-40 落成，现状）：直播这一侧的中立件已搬进核心的 `apps/server/src/live/`（推送类型与特性键、直播文案模板、`needsLiveMonitor` 判定、封面轮换与断流接续等待、内容构造口、`pushLiveNotify`），原先住在 B 站目录里、被拓展直播与统计借用；作品卡的样式覆盖解析搬进 `posts/card-style.ts`。`bilibili/live/` 只留 B 站特有的部分（房间会话、弹幕协议、B 站房间数据到 `LiveCardInput` 的翻译等）。直播并进来源那一半仍待 3b。
4. **共享件怎么归位（Q14b）**：
   - 两个及以上使用方的纯逻辑进 internal 零依赖子路径；
   - wire 形状进 contract；
   - 纯展示组件进 ui；
   - B 站专属的进 `bilibili/`；
   - 持久化底层进 storage。

   扫出来的重复全部在 1.0 施工里处理。
   🔗 现状（3b-49，10-25）：共享件按「core 是一等公民，其他都得从 core 导入，core 从不导入其他」重新归位。`packages/internal` 的 `constants.ts` 按领域拆成 `result.ts`、`identity.ts`、`features.ts`、`push-target.ts`、`platform-registry.ts`、`ai.ts`、`card-skin.ts`、`history.ts`、`update.ts`、`image-ref.ts`；链接预览并入 `link-preview.ts`，`/constants` 子路径撤掉。只给面板、contract 或拓展包要取值的块开零依赖子路径：`./result`、`./identity`、`./features`、`./push-target`、`./platform-registry`、`./ai`、`./card-skin`、`./history`、`./link-preview`、`./update`、`./extension/wire`。根入口 `.` 只放转出语句；子路径名单、零依赖与根入口只转出都由 `scripts/__tests__/internal-package.test.mjs` 钉住。`./platform-registry` 是平台闭集的隔离区，第 4 期照 ADR-0024 决策 1 整个删。拓展契约里的类型本体搬进 internal 的两个子路径（只有类型，根入口不转）：`@bilibili-notify/internal/extension`（ctx、handler 一层）与 `@bilibili-notify/internal/extension/wire`（交给面板去画的形状）。这份 wire 形状住 internal、不进 contract：拓展只能从门拿，门只转 internal 的东西；contract 从 internal `import type` 再转给面板。拓展包 `@bilibili-notify/extension` 只剩逐个写明的转出（没有 `export *`），自己的 `./wire` 子路径删掉。宿主（含拓展装载器与测试）与面板契约 `apps/contract` 一律不 import 拓展包，`package.json` 里也不声明，由 `apps/server/src/extensions/__tests__/extension-import-boundary.test.ts` 钉着、上限为零，另有一条守卫钉「门只转出」。设置字段族与 `PlatformAdapterDescriptor` 是内置与拓展共用的中立概念（ADR-0025 决策 3、ADR-0024 决策 3），不住 `extension/` 底下：字段族住 `settings-field.ts`、描述挨着 `PlatformAdapter` 住 `push-source.ts`，都从根入口转；改名、并名与上报类型的推导见 ADR-0019 决策 39 下 3b-49 的 🔗。
5. **核心账号模块叫 `accounts/`**，管「系统 → 账号」、账号排序、汇总各来源的登录态。B 站的登录系统进 `bilibili/auth/`。
    🔗 **2026-10-11**（3a-29 B 站半）：登录系统已搬进 `bilibili/auth/`（`createAuthSystem`、`LoginFlow` 与内部原形 `BiliLoginState`），对外只交 `Source.auth`；仍由入口 `index.ts` 造，登录装配进 `compose.ts` 随 3a-40。`accounts/` 本身没造，见决策 46 下的 🔗。
    🔗 **2026-10-12**（3a-40）：登录装配进 `compose.ts` 3a-40 也没做，留到 3b（主人 10-12 定，理由与被否的选项见 ADR-0025 决策 5 下的 🔗）。
    🔗 现状（3b-47，10-25）：`createAuthSystem` 已改为同步收现成的 `BiliContext`，在 `createBiliSource` 里造一次，并由来源 `start` / `stop` 管生命周期；登录不再由入口装配。

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
    🔗 **2026-10-12**（3a-42）：「共 10 个成员」是目标形状；代码里 `Source` 今天只有 5 个（`descriptor`、`health?`、`start`、`stop`、`auth?`），`searchCreators`、`fetchPreview`（第 4 期）与 `fetchProfile`、`fetchLiveStatus`、`liveInteractions`（3b）各随第一个使用者落地（「没有实现者的接口不造」）；守卫 21b 的「这版不开」名单逐项写着去处（见决策 59 下同日的 🔗）。
8. **与订阅无关的能力拆成横切接口（Q61）**：`LinkResolver`、`CommandProvider`、`AiToolProvider`，再加上 `DevtoolsProvider`（Q52）与 `PushOutlet`（Q43）。
   - 理由：只做链接解析的拓展，不该被迫去实现订阅源；契约的 `contributes` 本来就是按键分开声明的。
    🔗 **2026-09-28**：推送侧那个口叫 `PlatformAdapter`（ADR-0024 决策 2）；`CommandProvider` 1.0 不造，`login` 改成核心的通用指令（ADR-0031 决策 1）。
9. **每种接口一张登记表，全都建在现有的 `createClaimTable` 上**：
   - 表加一个 `entries()`，用来列出全部；
   - 键就是 `"bilibili"` 或拓展 id，不加前缀（09-27 S1）；分派读 `identity.sourceKey`；
   - B 站在 `compose.ts` 里逐个 `claim`；拓展按清单 `contributes` 的各个键，由宿主转换后登记；
   - 拓展停用、卸载时撤掉自己那一行，不用重启。

   理由：原先按订阅 `kind` 分派认不出是哪个拓展，所以一度给拓展的键加 `ext:` 前缀；身份摊平（决策 14）以后分派直接读 `sourceKey`。前缀只是为了防拓展 id 恰好叫 `bilibili`，而不带点的 id 本就只留给官方源（ADR-0013），再把 `bilibili` 列为保留 id（`ExtensionIdSchema` 拒收），手动放进目录的拓展也撞不上，前缀就不需要了。
    🔗 **2026-10-10**（3a-38）：保留 id 另加 `core`（核心自己的名字：日志等级表的键、设置文件名；日志等级的键开放以后拓展 id 会和它撞）。它只放进「拓展不许用的 id」那张表 `RESERVED_EXTENSION_IDS`，不进 `RESERVED_INTEGRATION_KEYS`，因为后者被当作「内置集成有哪些」读（开存储、导备份时逐个读密钥文件）。
    🔗 **2026-10-11**（3a-28）：订阅来源这一张表落成 `SourceRegistry`（`apps/server/src/subscriptions/registry.ts`），建在通用登记表 `Registry<T>` 上，实例挂在 `AppRuntime.sourceRegistry`；`entries()` 已补，第一个读者是会员档位读口（不是 `/api/sources`）。B 站由 `compose.ts` 登记，登记即 `await source.start(ctx)`、撤登记即 `stop()`（不等它）。其余几张表（链接解析器、AI 工具）这一片没建。🔗 现状（3b-47，10-25）：`SourceRegistry` 的撤登记把手会等 `stop()` 落定（最多 30 秒，到时记 warn），再收来源上下文；`EnginesRuntime.dispose` 也异步等在途撤登记落定。
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
    🔗 **2026-10-28**（4-14 服务端，主人照拟稿批）：`Source.fetchPreview?(identity, { kind: "post"; nth } | { kind: "live" }, signal)` 回 `PreviewReport`（作品即 `PostReport`，直播是与 `fetchLiveStatus` 同一份的开播时刻与详情），B 站实现、卡片路由只问来源登记表、不再收 B 站 `Api`。取真数据失败回落示例并说原因（回应 `sampleReason`，主人定）；拓展这一版不开（主人定，同 `auth`）。SC 示例的档位仍借 B 站价目表，做到中立另起一片（主人定）。形状细节见 `docs/1.0/subscription-sources.md`「预览」。
    🔗 **2026-10-28**（4-14 面板）：全局作用域的房间号 / uid 输入框换成「从订阅里挑一条」（可不挑），挑了作品卡再出「第几条作品」；按订阅覆盖对所有订阅开放（删了只列 B 站订阅的过滤）；示例卡的回落原因写在预览图下面，测试推送送达了也说推的是示例。
13. **AI 工具（Q57、Q68）**：
    - `packages/ai` 删掉对 B 站包的 import；
    - 核心提供中立的只读工具：`list_subscriptions`、`get_creator_profile`、`get_creator_posts`、`get_live_status`、`search_creators`；
    - 6 个内置女仆技能改用这些工具，留在核心，天然支持所有来源；
    - 来源专有的工具与技能经 `AiToolProvider`（`readOnly` / `chat` / `skills`）登记；
    - 缺工具的技能在面板上自动隐藏；
    - 删掉面板里 3 条找不到对应工具的死标签。

### 身份与订阅

14. **订阅身份摊平成 `{ sourceKey, externalId }`（09-27 S1，修订 Q4 的判别联合），取身份的函数叫 `subscriptionIdentityOf`**。`SourceKey = "bilibili" | 拓展 id`；B 站的 uid 就当 `externalId`，中立层不再出现 `uid`。判重看这两格是否都相等。盘上也按这个形状存，「盘上平铺、读时映射」被 Q30 推翻。`sourceKeyOf` 退化成读字段；`SubscriptionKind` / `isBiliSubscription` / `isExtensionSubscription` 删掉。
    🔗 **2026-10-15**（3b-58，主人定）：**外部 id 长什么样由来源在描述符里声明，核心照着核，不再在核心里写哪个平台的规矩**。`SourceDescriptor` 加 `externalIdRegex?`（正则的源码字符串，词照内容过滤的 `blockRegex` / `allowRegex`）；核心按整串匹配核两样：新建订阅时身份的 `externalId`，保存时特别关注名单每一条的 `id`（同一个平台上创作者与观众是同一套用户 id）。没声明的来源只做中立校验（非空、限长）。B 站声明纯数字。路由里按 B 站分岔核 uid 的那一处（`biliExternalIdRefusal`）随之撤掉。正则由集成自己写：注册时编译不过就拒收这个集成；被核的值有长度上限，写坏的正则拖不住保存。不选的：在路由里为特别关注名单再开一处 B 站分岔（核心多欠一笔中立化的账、没有清除的路）；不核（「填错了静默失效」的老 bug 回来）。
15. **订阅合成一个文件、一次原子写；备份里订阅也只留一节，备份 schema 抬版（Q55）**。同一个 uid 的重复订阅，照旧分发给每一条。
    - 理由：当初分成两个文件，是为了回退到旧载荷时旧版读到的是自己的格式。有了数据代（ADR-0022 决策 1），回退读的是旧代，这个理由没了。
16. **显示名只有一条链，别名退役（Q8）；运行期状态只留资料缓存与问题表（Q19；09-27 S3、S6）**。问题表 `problems` 按 code 做键、多条并存（原先单数的 `problem` 装不下）；运行态统一叫 State：`SubscriptionStateStore` / `SubscriptionState` / `subscription-state.json`。
    🔗 **2026-09-28**：问题表不再存进订阅运行态，改成全在内存的一张表（ADR-0025 决策 11）；运行态只留资料缓存。
17. **特别关注的名单 `specialUsers { id, note? }[]` 进公共的订阅形状**。露不露这个设置，看 `descriptor.supportedFeatures` 有没有声明特别弹幕或特别进场（Q69，推翻 Q41「只挂在 B 站订阅上」）。
    🔗 **2026-10-13**（3b-16，主人定）：**名单留着「哪个人触发哪种推送」，仍是一张；名字与条目形状改了，修订本条原文的 `specialUsers { id, note? }[]`**。名单改叫 `specialViewers`（条目 `SpecialViewer`，比对文件 `live/special-viewers.ts`）；条目上多一格 `features`，装特性键、必填至少一个；死格 `template` 退役。迁移要有专门的测试钉住老键 `specialUsers` 上的名单一个不少地到新键。特性键改名见决策 30 下的 🔗。
    🔗 **2026-10-15**（3b-58，主人定）：条目的 `id` 不再在 schema 里写死「B 站数字 UID」，改由来源描述符的 `externalIdRegex?` 核（见决策 14 下的 🔗）。
18. **补关注在登录失效时跳过，停用的订阅不补（Q14）**。关注同步是 BN → B 站单向（订阅了谁就补关注谁，因为动态从关注流里拉），全在 B 站内部（决策 56）：在 `onSubscriptionsChanged` 回调、开机、重新登录后各跑一次，整份名单先批量查关系、只补缺的（稳态写请求为零），失败按决策 47 报 `follow_failed`（09-27 S9）。停用的订阅不在名单里，自然不补。
    🔗 **2026-10-11**（3a-31，主人定）：关注只为从关注流里拉到动态，所以补关注**只对启用中、且作品开关开着的订阅做**（只开直播的订阅既不查关系也不补；不取关）；开关从关到开（订阅被启用、订阅自己的作品开关打开、全局作品开关打开）时补一次。关注同步今天仍住 `runtime/follow-sync.ts` 与引擎装配（开机、登录恢复、开关翻开三处触发），不是挂在 `onSubscriptionsChanged` 上；搬进 B 站来源的那一步没有单独的片认领。
    🔗 **2026-10-14**（3b-25，主人定）：**关注搬进 B 站之后**，补关注在「订阅名单变了」的回调里异步做，失败报 `follow_failed`（带 `externalId`、挂在那个人的订阅上、只进问题表）；新建订阅的回应不再带关注结果；订阅列表的回应由宿主把挂在这条订阅上的问题一并带上，面板订阅卡通用地显示它们（去掉「是不是 B 站」的判断），问题变了面板刷新 —— 这是提前到 3b 的一小块面板活。
    🔗 **2026-10-23**（3b-25 落成）：关注同步住 `bilibili/follow-sync.ts` 的 `syncFollows` / `watchFollows`，由 B 站来源在开机（已登录）、`auth.onChange` 恢复成 `logged-in`、`onSubscriptionsChanged` 三处触发；名单变化只补相比上一次新进入关注范围的外部 id。整批关系查询回 `unauthorized`（B 站 `-101`）时整批跳过，不降级；其他查询失败仍降级为逐个幂等补关注。失败经 `ProblemLayers.reportFailure` 的第三层上报，带 `externalId`、`lasting: true`、只进问题表；成功或已关注时清，离开关注范围按「不再适用」清。`followed` / `followError` 不再存任何地方。
    🔗 **2026-10-27**（3b 期末审查 R14）：上一条的「只补新进入」再补一条 —— 撞风控 / 未登录没处理完的人记进 `pending`，随下一次名单变化一起补（`added ∪ (pending ∩ next)`），全量那一轮（开机、登录恢复）之前清空；撞风控整批跳过、不降级、这一批不报 `follow_failed` 的行为不变。🔗 主人 10-27 定：欠着的非空时按 `RISK_BACKOFF_STEPS_MS`（`riskBackoffStepMs`，60 秒 / 5 分 / 15 分 / 30 分，到顶一直 30 分）自己再跑一轮，每轮只跑「欠着且还在名单里的」那几位、先只发一个读，还在风控就整批跳过、不写；补全就停、档位归零，没补全进下一档；同一时刻最多挂一个计时器，名单变化 / 登录恢复的全量跑完后按同一规矩重判，没登录不跑，`dispose` / `signal` 中止时收掉。

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

    🔗 **2026-10-05**（㉑ 开片拷问，主人拍板）：
    - **㉑ 只换到出卡这一层**：`Post` 类型族与取段函数落在 `internal`（`posts/` 3a 才建）；B 站原始数据到 `Post` 的翻译先放 `packages/dynamic`，拓展上报到 `Post` 的翻译放服务端；出卡器改吃 `Post`。`NeutralWork` 留到 3a、里面带上 `post`，是认了的过渡包装；`PostEvent`、`post-detected`、`deliverPost` 改名、图集载荷改名都在 3a。
    - **`Creator` 照原样只收引用，不加过渡格**：B 站作品卡到 3a 之前不画头像（主人：开发阶段不用 B 站卡，alpha 在 3a 之后）。B 站作品里的配图与封面仍带 `url` 照旧画（10-03 定）。
    - **拓展作品的图这一片就进图库**：收到上报时存图、`PostImage` 只放 `ref`，出卡器按引用从图库取图。图库登记一个写入方 `postImages`；作品是在途数据不落盘，它没有引用可列，图靠 24 小时宽限期活到卡片画完。
    - **B 站卡的字节，形状逼着变的就变**：正文链接与附加块每行的小图标到 3a 之前不画（图标只能是图库引用，B 站 3a 才存）；播放数与时长先解析成数字、再由核心统一排版。去头像、去图标、数字排版各自单独一步、单独记进批准清单。形状不逼的保持字节不变、留给 ㉔：`label` 出卡时照旧拼回老皮肤字段，充电专属占位的颜色不动。
    - **类型开关对所有来源生效**（决策 43）随 ㉑ 落：面板里拓展订阅也露出四个开关，屏蔽提醒的措辞改中立。
    - **两个直播阈值 `minScPrice` / `minGuardLevel` 留给 ㉓**：㉑ 只改四个类型开关与白名单的名字。
    - **`Post` 加一格 `title?`**（施工中补问）：有标题、但不是文章的作品（B 站带标题的图文动态、小红书的笔记）用它，画在正文上方、排版照普通作品；`article` 只给真正的文章。取段时它和文章标题同一个待遇。
    - **`Post.video.durationSec` 改成选填**（施工中补问）：直播回放、首映没有时长，没给就不画时长角标，与附加块的视频对齐。
    - **表情图、附加块里形状装不下的小东西同样不画**（施工中发现，按上面「形状逼着变的就变」办）：B 站正文里的表情到 3a 之前画成文字；预约按钮的铃铛、商品卡的图标与「去看看」按钮和价格后的「起」、通用卡的「游戏」标签、引用视频卡上方的小字都不画，预约卡的说明一行一段、不带颜色。后面这几样附加块的形状里没有位置，3a 之后也是这样。

    理由：缓存与防护只在核心留一份，拓展不用各自写一套下载；所有来源交给 BN 的都是同一种形状。

    代价：交作品时就抓图，被过滤掉的作品，它的图也白抓了。抓失败时由来源决定是跳过，还是只给 `url`（卡片上显示占位）。
    🔗 **2026-09-28**：`fetchImage` / `storeImage` 返回结果形状；`fetchImage` 走集成自己的请求客户端，每一跳重定向都查（ADR-0025 决策 8、10）。
    🔗 **2026-10-07 B 站的抓图时机**：B 站的作品图与直播封面不在「交作品时」抓，而是**过滤之后、确定要出卡时**才抓（被屏蔽的、关了出图的、版式把卡片块藏了的一张都不抓；静音与免扰不影响，决策 34）。图库里存 B 站图床的缩放版（宽 1280、质量 80、只取第一帧、webp），抓不到再试原图，`url` 留原图地址；抓不到的图只给 `url`。和拓展「上报时就抓好」的时机不同是有意的：B 站的过滤与出卡今天还在同一段代码里，能省掉白抓。B 站改成按 `SubscriptionSource` 上报之后这个时机要重看（3a-28）。
23. **头像也走 `fetchImage`（Q75，修正 Q62）**：资料里的 `avatar` 是 `ImageRef`，B 站图链没变就不重抓。作品图、直播封面、头像、历史快照都引用同一个图库，图库的位置与清扫规则见 ADR-0022 决策 9。面板一律走同源地址，删掉 `no-referrer` 绕行。
    🔗 **2026-10-07 落地方式**：B 站资料里 `avatar`（图库引用）与 `avatarUrl`（那张图的来源地址）两格都留，「图链没变就不重抓」靠比对 `avatarUrl` 判断；规矩是只要有 `avatar`，`avatarUrl` 就是它的来源地址（抓到两格一起换；抓不到且原来有头像，两格不动、下一轮再试；抓不到且原来没头像，只记新地址）。头像存 B 站图床的小一档缩放版（宽 480、只取第一帧、webp），抓不到不回退原图。卡上的主播头像在**出卡那一刻**按订阅 id 现读资料，不抄进引擎的订阅视图（视图只在开机与订阅变更时重建，抄进去会旧）。不在资料里的头像（转发的原作者、醒目留言与上舰的观众、预览里没订阅的 UP）出卡前现抓，抓不到就不画、卡照出。
24. **数字、时间和「不知道」（Q5、Q6、Q7、Q9）**：
    - 人数传精确数，缺了就不写这个键；
    - 时刻是 ISO 字符串、以 `…At` 结尾，时长的名字带单位；
    - 计数全程是数字，只在出口由 `formatCount` 排一次版；
    - 时长的格式化只有一份 `formatDuration(start, end)`。
    🔗 **2026-10-05**（㉒ 开片拷问，主人拍板）：
    - **直播卡输入的名字这一片一起改到最终形状**（`creator`、`category`、`currentViewers`、`followers`、`followersDelta`），不留到 ㉔：这一片本来就要把这个类型的每个调用方都改一遍。`LiveCardView` 与皮肤字段名仍归 ㉔。被否的备选：只改形状、名字 ㉔ 再改（同一个类型动两次）；连视图与皮肤字段一起改（提前做半个 ㉔、动皮肤契约）。
    - **B 站直播卡 3a 前不画头像**，照决策 22 下 10-05 那条作品卡的先例：`Creator` 只收图库引用、不加过渡格。前提同前：3a 排在第一版 alpha 之前。
    - **观看人数改数字一路改到面板**：总线事件、契约在播行、面板同片改，只改类型不改名（事件的最终形状归 3b）。出口排回文字那条路走不通：总线还是字符串的话统计就得继续解析「1.2万」，而解析只许留在迁移模块。
    - **名字**：出卡器入口 `generateLiveCard`（只吃中立输入，与 `generatePostCard` 成对）；B 站翻译 `liveCardInputFromRoomInfo`、拓展翻译 `liveCardInputFromReport`；拓展直播的图库引用方 `liveImages`。
25. **字段改成中立名（Q40）**：`description`、`category`、`currentViewers` / `totalViewers`、`bio`、`isPremium`、`amount` + `currency`、`followers`、`followersDelta`；`danmaku` 不改。`Post.video` 表示作品本身就是视频，不设视频级的互动数。
    🔗 **2026-10-05**（㉑ 开片拷问，主人拍板）：`video.views` / `video.danmaku` 留着，是视频自己的展示数字、卡上照画；这句的本意是点赞、评论、转发这类互动数只在 `Post.stats`。
26. **会员按「体系 + 档」建模（Q37）**：
    - 来源声明体系 `{ id, name, tiers | "custom" }`，每一档带 `rank`，1 是最低；
    - 事件带体系与档，可选带开通方式、月数、赠送、金额；
    - 推送阈值改成按体系设的 `minRank`；
    - B 站的体系叫 `guard`，它等级倒序的换算只在 `bilibili/` 里做。

    理由：调研了虎牙、斗鱼、快手、YouTube、Twitch、Kick，会员普遍是「体系 + 档」，只是档数与名字各不相同。
    🔗 **2026-10-05**（㉓ 开片拷问，主人拍板；逐条与被否的备选见 construction-plan「㉓ 开片」）：
    - **B 站的档位表 3a 之前住 `packages/internal` 的一个文件**（名字带 `bilibili`），面板、引擎、出图器共读，3a 搬进来源描述符。
    - **档色留卡片那一套**，面板色块跟着变。档位另有可选的止色 `colorEnd`（卡的背景从 `color` 渐变到它，没声明就是单色），B 站三档填 0.x 的止色，会员卡的样子不变。2026-10-06 更正：开片时定的是「每档只有一个色、止色取同值」，漏了默认皮肤的外框背景是两色渐变，施工时发现后主人改定加这一格。被否的备选：就用单色（老用户的卡变平）；出图器自己推一个止色（等于新设计一套配色）。
    - **`custom` 体系这一片只建类型与取值规则**（按档的 key 取、取不到用体系默认），面板留 3b。
    - **会员事件上没有房管这一格**，卡上那段「把主播名换成房管」的替换删掉（ADR-0023 决策 3 那句随之作废）。
    - **没配门槛就是全推**；逐订阅覆盖里的 `minRank` 按体系合并。认不出的档位丢掉并记警告。
    - **上舰文案的默认值是一句带 `{tier}` 的体系默认**，迁移时没动过的档不搬、改过的才进每档覆盖。
    - **醒目留言卡与会员卡两组皮肤字段随这一片改到最终名字**，卡种键与抬皮肤格式版本仍归 ㉔。
27. **周期推送的「正在直播」由核心计时，调 `fetchLiveStatus` 拿三种结果（Q35、Q53）**：
    - 在播：带着数据，推卡；
    - 已下播：走和下播同一条路，包括断流宽限与私聊提示，这就补上了漏收下播的兜底；
    - 拿不到：跳过这一轮，记一条问题，不再停止监听。

    计时按每一场的开播时刻各自起算，不全局同时拉。拓展停用时，用 `signal` 取消还在进行的调用。
    🔗 **2026-10-14**（3b-22，漏收下播的兜底与周期推送拆开，主人定；落细处主会话照规矩定）：**凡在一场直播里的订阅都按间隔核一次还在不在播；周期推送开着照推「正在直播」卡，关着只核不推、间隔用默认 1 小时**，修订上面「计时」只服务周期推送的写法。周期拿不到房间信息，照上面第三种结果原文：跳过这一轮、记问题、不再停止监听。重连后核对发现已下播，也走同一条下播的路。直播互动（弹幕、醒目留言、会员、进场）走回调、不走总线（「以后再说」里「施工时再定」那条的结论）；观众头像与档位图标在确定要出卡时再取。合进核心那套之后，开播看 `liveStart` 开关；漏收下播的时长算到「发现已下播的那一刻」。
    🔗 **2026-10-21**（3b-23，主人定）：场次引擎按开播时刻分场（守住「场次身份按开播时刻认」）；会员与醒目留言不开总线事件，互动汇总由场次引擎攒、随结束帧交统计。
    🔗 **2026-10-21**（3b-22 落成）：`LiveSessionEngine.apply` / `tickNow` 按每一场自己的开播时刻计时，经公共外壳 `callSource` 调 `fetchLiveStatus`，同一来源键串行。`ok: false` 只跳过这一轮并记日志，问题由来源自己报；B 站的 `live_status_unavailable` 走分层上报。断流等待期间在播表保留这一行。
28. **直播场次引擎合成一套（Q58）**：
    - 拓展那套场次引擎本身已经是中立的，去掉前缀，升格为核心的 `live/`；
    - 输入有两种：推送式的 `LiveSignal`（开播、状态、下播，B 站把弹幕通道翻译成这三种），和拉取式的 `fetchLiveStatus`；
    - 重启以后，核心逐个调 `fetchLiveStatus` 重建场次；
    - `room-session-base` 删掉；
    - 场次身份照旧按开播时刻认，`current` 与 `isLive` 的语义原样保住。

    验收：先在旧引擎上用端到端测试钉住开播、下播、断流接续、漏收下播兜底四种行为，再换成新引擎跑同一组测试。
    🔗 **2026-10-21**（3b-22 落成）：核心 `live/` 的 `LiveSessionEngine` 同时接推送式 `ctx.reportLive` 与拉取式 `fetchLiveStatus`；B 站直播间连接搬进 `bilibili/live/session/` 的 `BiliLiveRooms`，在 B 站来源里把弹幕帧翻成中立信号与互动上报。删掉的是 B 站那套老引擎 `LiveEngine` 与 `room-session-base.ts`。
29. **重启后的补推挂在 `liveStart` 下（`catchUpOnBoot`），`liveStreaming` 只管周期复推（Q21）**。

### 特性键与皮肤字段

30. **特性与卡种全用中立名，由核心登记（N3）**：
    - 推送种类与特性键同名；
    - 直播拆成 `liveStart`、`liveStreaming`、`liveEnd` 三把键（Q17，推翻 N3 的「live 不变」）；
    - `liveGuardBuy` 改为 `membership`；
    - 醒目留言、会员、特别弹幕、特别进场、词云、直播总结都是核心的中立特性，只是现在只有 B 站填数据。
    🔗 **2026-10-13**（3b-16，主人定）：**特别关注那两把键改名，推翻 N3 记的「`superchat` / `specialDanmaku` / `specialUserEnter` 名不变」**：`specialDanmaku` → `viewerChat`，`specialUserEnter` → `viewerEnter`（`superchat` 不动）。同批：核心里直播一侧的 `danmaku` 换成 `viewerChat` 一族（`ViewerChatCollector`、`recordViewerChat`、`viewerChatCount`），视频上的弹幕数 `video.danmaku` 不动（10-05 的定案）。上面「特别弹幕、特别进场」读作 `viewerChat`、`viewerEnter`。
31. **皮肤字段跟 `Post` 一一对应（N2）**：
    - 字段装的就是名字说的东西，跨卡种同义（Q38）；
    - 排好版的文字不以 `…At` 结尾；
    - `up.*`、`master.*` 统一为 `creator.*`（ADR-0023 决策 1）。
32. **老卡片皮肤不适配（Q31）**：皮肤包的 schemaVersion 抬版，旧包拒收，卡片只用按 1.0 契约新生成的皮肤。迁移时怎么处理指向老皮肤的指针，见 ADR-0022 决策 12。
33. **文案模板（Q10、Q11、Q11b）**：模板加 `{noun}`，取自 `descriptor.postNoun`；直播文案里的 `-key` 迁成 `{key}`，全仓只用一个模板引擎；人名变量统一为 `{name}` / `{viewer}`。
    🔗 **2026-09-28**：变量改叫 `{postNoun}`，与提示词变量同名；`{noun}` 从没上过盘，直接改名、不用迁移；默认文案「{name}发布了一条{postNoun}」保留「一条」（ADR-0028 决策 3）。
    🔗 **2026-10-24**（3b-12，主人定）：默认文案按语言各一份，住 `packages/internal/src/locales/<语言码>.json`，经 `@bilibili-notify/internal/builtin-texts` 的 `templateDefaultsFor(locale)` 取。设置只存主人改过的文字；没改过的在服务端 `resolveTemplates` 读取时按当前语言补，换语言立即生效、不写盘。今天只有简中含有这批出厂文字，其余语言拿简体打底。
34. **静音与免打扰只管推送（Q20）**：被挡下的目标落一行 `silenced`、存下重推原件；它不算推送，也不算失败，补发闸会放行它。
    🔗 **2026-10-08 一次推送是一个对象，时间上的挡只判一次**（主人定）：本体加它的附加项（@全体、图集、词云、总结）是同一次推送，引擎一次交给推送层：`PushRouter.push(push)`，`Push = { subscriptionId, feature, allowAtAll?, anchors }`。`anchors` 是按顺序排好的**锚点**（`PushAnchor = { role, extra?, messages }`）：`role` 是 `main`（本体，可以没有）或 `extra`；`extra` 是附加项的键，给了就按那张三态表筛目标，不给就发给路由里所有启用的目标（图集）；`messages` 是现成的内容，或一个「等会儿给」的约定，最后为空就跳过、做的时候出错记日志并跳过（没做出来不是没送到，不记失败）。**交进来那一刻判一次**：订阅还在不在、这种推送的总开关、全局静音与免打扰；裁决管整次推送——放行了，之后的锚点不再看时间（22:59 下播卡发出、23:01 写好的总结照发）；挡下了，免打扰结束后才好的锚点也一起挡，记在同一行里，补发时一起补。**锚点按顺序发**：内容并行做，发送按锚点先后——前一个发完（有了结果）才发后一个，后面的早好了也等；每个目标各取自己该收的锚点、各自排队。**@全体 也是一个锚点**，由推送层自己插在本体前面（要不要 @、@ 哪些目标只有推送层知道）；它是唯一「只保证先后、不等结果」的锚点：先交出去、本体紧跟着交出去，成败事后记进历史（没有管理权限的群会让它反复重试，等它的结果会把卡片拖住，是修过的事故）。`push()` 在本体那个锚点发完时返回，之后的锚点在后台接着发并登记进关停流程，所以这条订阅的下一次推送不等上一次的附加项——「送达次序 = 发起次序」对附加项是按锚点、不按订阅队列。**每条消息发出时按目标判的不变**：目标还在不在路由里且启用（ADR-0017 决策 10 的复查）、附加项三态表的收窄（先收窄再记被挡）、逐目标挑正文、连接支不支持 @全体。被否：「开一次推送、再一轮一轮往里交」的三步接口（照今天的调用习惯描出来的，引擎要拿着一个打开了的推送到处传）；推送层按编号另记一张裁决表；每一轮各判一次（会出现本体送到、附加项被时间挡下的混合行）。
    🔗 **2026-10-08 `silenced` 怎么记**（主人定）：记在消息上——被挡的每条消息带 `isSilenced: true`、没有结果；行的状态照旧只从消息推（被否：记在行上，分不清被挡的和因前一条失败而没发的；写成失败码，被挡不是失败）。不区分静音还是免扰。被挡的 @全体 不记（它是发送那一刻现造的，记下来的话几小时后补发会再 @ 一次全体）。面板：历史页照列，标签「已静音」用未发送那支灰色，首页「最近推送」不列，按钮一颗「补发」；不弹小卡、不加按状态筛选（09-05 否过）。连带后果：静音期间没有可用目标的推送会开始落「无目标」行（今天静音闸排在最前，什么都不落）；静音期间上舰、醒目留言这些每条都会落行、存原件、卡片图进图库。
    🔗 **2026-10-08 被过滤的作品也留痕**（主人提出并定）：过滤挡下的作品在推送历史里记一行，**只留痕、不生产**——不出卡、不抓图、不调 AI、不存重推原件，所以不能补发（被否：和静音完全一样照常生产，为主人明说不要的内容花钱、量可能很大；留痕并存下作品、补发时现做，要新造「事后装配」这条路）。**一条订阅记一行**，目标那一格空着，和「无目标」行同一种形状、靠状态分（被否：路由里每个目标各记一行，过滤是订阅的规则挡下的、按目标拆没有信息量，只会把历史刷满；静音按目标记是因为各目标该收的内容不同、补发按目标补）。状态取值 `filtered`，行上 `filteredBy` 记原因（沿用现成的六种 `PostFilterReason`）；用「过滤」不用「屏蔽」，因为六种原因里有一种是没命中白名单，「过滤」是总称、「屏蔽」只是其中一类规则（被否：`blocked` / `blockedBy`）。面板：标签「已过滤」，展开写具体原因（屏蔽转发、屏蔽关键词、屏蔽专栏、屏蔽图集、屏蔽视频、未命中白名单），未激活的灰色；不算今日推送也不算失败，首页最近推送不列，不弹小卡，没有补发按钮；行里一条文字是正文摘要加原帖链接。**「屏蔽后提醒」的代码删掉**（主人定）。更正：主会话问这一题时把它说成了一个开着就会往群里发一句的现有功能，施工时查实它在独立端**从来没有设置项、面板上没有开关、盘上没有这一格**，引擎里那段发提醒的代码生产里走不到，只有测试手工打开才走——它是从旧形态带过来的死代码。所以删掉的只是那段代码、`blockedNotice` 与引擎侧类型上的 `notify`，不动设置、不迁移、不抬修订号与备份版本。接法：引擎多一个专门的出口 `onPostFiltered`，交出 `FilteredPost`（哪条订阅、`filteredBy`、摘要文字），装配处接到历史上；留痕不是推送，不经推送层（被否：给推送层加一个不发东西的方法；走事件总线，为一处内部接线多开一条对外可见的通道）。
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
    🔗 **2026-10-14**（3b-04，主人定；格式不动是主会话照规矩定）：**1.0 的新规矩落在新的官方索引上**。新版 BN 改读新的滚动 release `extensions` 上的 `marketplace.json`，每个契约版本各留一条、只挑装得了的；旧 release `extension-marketplace` 上那份留给 0.12、从此不动，它的说明里写「0.12 专用，已冻结」。格式不顺手改：`issuedAt` 仍是秒（进门换 ISO 照 data-model 那条）、`apiVersion` / `apiRevision` 不改名。
38. **1.0 对拓展只开放这些（Q76、Q77）**：
    - `contributes`：`subscription`、`push`、`devtools`；
    - `ctx`：`subscriptions`（改形状，决策 56）、`fetchImage`、`storeImage`、`state`、`secrets`、`redact`、`reportProblem` / `resolveProblem`。
    - 拓展的 `supportedFeatures` 只能声明 `post`、`liveStart`、`liveStreaming`、`liveEnd`；声明了 `liveStreaming` 就必须实现 `fetchLiveStatus`。宿主装载时校验，不合规就拒收并说明原因（09-27 S5）。
    - 契约里拓展的 `lookup` / `lookupPlaceholder` 改名 `searchCreators` / `searchPlaceholder`（09-27 S8）。
      🔗 **2026-09-29**：`searchPlaceholder` 又换成声明式的 `searchAccepts`，见决策 10 下的 🔗。

    `linkResolver`、`commands`、`aiTools` 暂不对拓展开放：核心的接口与登记表照做，B 站照用，等写抖音拓展时再定。以后加进来，只是清单里多几个可选键，不用抬大版本。
    🔗 **2026-09-28**：ctx 改成 `IntegrationContext` 加各自特有的一层，新增 `http`、`settings`；上报类改成 `void`，被拒记进 `reportRejections`（ADR-0025 决策 1、6、10）。
    🔗 **2026-10-09**：上一条里的 `reportRejections` 改叫 `reportDiscrepancies`（ADR-0025 决策 10 下的 🔗）。
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
      🔗 **2026-10-23**（3b-25）：实际只搬了 `roomId`，住 `ctx.state` 的 `room:<uid>`（`bilibili/live/room-ids.ts`）；`followed` / `followError` 哪里都不存，关注失败由 `follow_failed` 问题顶替，依据 `subscription-sources.md` 3b-25 那条「只在内存、不再存盘」。盘上旧三格与 0.x `roomId` 的拆分归 3b-62 的迁移。
      🔗 **现状（3b-62，10-24）**：迁移已落，0.x 的 `roomId` 拆进 `runtime/bilibili/state.json` 的 `room:<uid>`（正整数字符串），拓展订阅与对不上的 `roomId` 丢弃；`followed` / `followError` 丢弃。订阅运行态同时迁成 `runtime/subscription-state.json`，每条只留 `cachedProfile?: CreatorProfile`。
    - **拓展**：「不读写文件」写进契约；官方市场发布时做静态检查，打包产物 import 了 `fs` 就不收；手动安装的第三方拓展在安装时警告。
    - **真正的强制要靠沙箱**：拓展与 BN 在同一个进程里，现在拦不住，见「以后再说」。
    🔗 **2026-09-29**：守卫 17 扩到 `platforms/`：内置平台适配器也是集成（ADR-0025 决策 1），同样不读写文件。

### 配置与密钥

42. **设置用单文件分段 `config/settings.json`，分 `core`、`bilibili`、`extensions.<id>` 三类段（Q60b、Q25）**：
    - 每段的 schema 由归属方定义，核心负责组合；
    - 拓展段校验失败，只停用那一个拓展，BN 照常开机；
    - 卸载拓展时删掉它那一段；
    - 守卫禁止核心代码读 `bilibili` 段。

    理由：拓展是给 BN 加功能的，它的设置本来就是 BN 的设置；现有的原子写和写入队列版本号，都是按「单文件 + 一条队列」写好的。
    🔗 **2026-09-28 改成只停那一处**：拓展段与 `bilibili` 段坏了只停那个集成；`core` 段逐格退回默认并记问题；只有信封坏了才挡开机（ADR-0025 决策 4）。
    🔗 **2026-10-01 改成按集成分文件**（⑥f 拷问）：`config/settings/core.json`、`config/settings/bilibili.json`、`config/settings/extensions/<拓展 id>.json`，目录照 ADR-0025 决策 1（内置集成直接用键、拓展进 `extensions/`）；一个文件就是一段。拓展的开关 `enabled` 归宿主、留在 `core.json`，拓展自己的文件只装它的设置 —— 开关放进拓展的文件，那个文件一坏，关掉它的开关也读不出来。理由：单文件那条「原子写和写入队列按单文件 + 一条队列写好」已经不成立（配置仓本来就是多个文件、一个文件一条写队列，恢复备份还能跨文件整体替换）；「坏了只停那一处」分到文件上，连整份解析不了也只坏那一个；守卫 12 收成「核心不读 B 站那个文件」。各集成只拿得到自己那一份靠 ctx 交什么，与文件怎么摆无关。
43. **核心配置去掉 B 站的形状（Q25）**：
    - 过滤看 `Post` 上「有没有」某样东西，放在装配第一步，对所有来源生效；
    - SC 阈值按人民币算，别的币种先放行；
    - 特别关注去掉 uid 正则；
    - 卡片时间读全局时区，默认 Asia/Shanghai。
    🔗 **2026-10-20**（3b-11，主人定）：核心设置顶层落成 `timezone`，**只收 IANA 名、不收 `+08:00` / `UTC+8` 这类偏移写法**，带 `.default("Asia/Shanghai")` 落盘（老配置缺这一格由 `parse` 补上，零代迁移不写）。出卡器在**出卡那一刻现取**（宿主注入的 `ImageRendererOptions.timezone`），改设置不用重启，后续的卡立刻跟上。管到哪：卡上的时间（作品卡的发布时间、直播卡的开播时间）加两处服务端按天切（榜单周报与单人锐评、AI 读创作者统计）；不带偏移的 ISO 当全局时区读，带偏移的换算过去。**不跟**：B 站进门时的北京时间（`live_time` 是 B 站的数据格式）与票据 cron 写死的 `Asia/Shanghai`。其余服务端墙上时间（静音回话的钟点、AI 工具回给模型的日期、免扰时段判定连同开发版的免扰时钟、三条 cron 与开发版定时器的显示）这一期不跟，见 `docs/1.0/construction-plan.md`「还没归期的」，第 4 期面板露出时区那一格时一起定。
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
    🔗 **2026-10-11**（3a-29，主人定）：`AuthState` 落成六种取值，其中两处改了定案原文。① `scanned` 换成 `confirming`（可选 `message`）：BN 自己推断出的「还在等 / 还在核，此刻不算登录」，两种情况都用它 —— 手机上已扫、等主人点确认；手里有登录信息、开机还没向平台确认过有效（B 站原来的「正在加载登录信息」）；扫码确认之后、账号信息还没取到的那一小段对外仍是 `logged-in`。取值仍是六种，被否：新增第七种；把开机没确认映成 `error` 或 `logged-out`。② `expired` 只指「已经登着的登录失效了、要重新登录」，二维码超时、失效两边都报 `error` 并带一句话（被否：两边各说各的；两件事都报 `expired` 靠 `message` 分）。`awaiting-scan` 的二维码直接带图片数据（`qr: { dataUrl, expiresAt }`），不走图库引用，见 `docs/1.0/subscription-sources.md`。
    🔗 **2026-10-11**（3a-29 B 站半，主人定范围甲档）：`SourceAuth` 落成五个成员 —— `beginLogin()`、`logout()`、`state()`、可选的 `account()`、`onChange(fn): Disposable`（住 `packages/internal/src/source.ts`，`Source` 多一格可选的 `auth`）。**`methods` 与 `beginLogin` 的 `method` 参数、`"cookie"` 不造**（没有第二种登录办法的实现者，也没有预知的使用者；等第一个有两种登录办法的来源，连同配套问题一起设计）。**通知口是 `onChange`**：集成不拿总线，由宿主订阅后发总线事件 `subscription-auth-changed`（ADR-0023 决策 6）。`account().avatar` 是图库引用，图库多一家引用方「账号头像」（主人定）。没有 `refresh`：「刷新 Cookie」整套删（主人定），续期是 B 站自己的事。落成的路径见 ADR-0036 决策 5 下的 🔗，细节见 `docs/1.0/subscription-sources.md`「登录与账号」。
    🔗 **2026-10-14**（3b-51，主人定）：**有登录口的来源不报登录问题，由宿主看登录状态报**。宿主订每个有 `auth` 的来源的 `onChange`，按 `AuthState` 自己报与清（`expired` 进表并私聊，`logged-out` 只进表，`logged-in` 清，其余三种保持上一次的结论），记在来源名下；宿主写整句并带指路（面板账号页、`login <来源>` 指令）。契约不加成员。细节见 ADR-0025 决策 11 下的 🔗。
46. **头部显示哪个账号，由主人在「系统 → 账号」里拖动排序决定（Q66）**：
    - 顺序存进核心配置，进备份；
    - 默认按登记顺序，B 站在前，新来源追加在末尾；
    - 排第一的显示在头部，其余的在小三角下拉里；
    - AI 对话里主人的头像和头部一致；
    - 新手引导的登录步，由声明了 `auth` 的来源生成。
    🔗 **2026-10-11**（3a-29，主人选范围甲档）：`accounts/`、账号排序（`core.accounts.order`）与它进备份、多账号下拉、按来源生成的引导登录步**推到第 4 期**，3a-29 不造：今天只有 B 站一个有登录的来源，读者都在第 4 期的面板改造。已记进 `docs/1.0/construction-plan.md` 的「以后再说」。
47. **问题上报是事件（Q67；09-27 S3 定写法）**：
    - `ctx.reportProblem({ externalId?, code, message, notify?: boolean })`；
    - `ctx.resolveProblem({ externalId?, code })`。

    严重度、文案、要不要打扰主人，全由来源决定：问题一律进面板问题框，`notify: true` 再私聊主人。不填 `externalId` 是来源本身的问题；填了由核心展开到订阅，按 code 存进 `problems`（`since` 记第一次出现，重复报只更新文案）。code 用 snake。核心只守一条底线：同一来源、同一 code 的私聊，60 秒内只发一次。核心收到每条问题都自动记一行日志；只想记日志就用 `ctx.logger`，两者不合并。B 站的「登录失效」也走这里。

    理由：原先的泛型 `report(kind)` 在一堆 `reportX` 里是孤例；`level: "panel" | "notify"` 的两个值其实是「发到哪」，不是严重程度；拓展详情页那个「上报被拒」的框改名 `reportRejections`，和来源自报的问题分开。
    🔗 **2026-09-28**：问题表的形状、生死规矩与推给面板的方式见 ADR-0025 决策 11；平台适配器也能报，带 `connectionId`。
    🔗 **2026-10-14**（3b-51，主人定，推翻 3a-30「B 站问题文案女仆口吻」的定稿）：**「文案」改成「事实句」**。集成（B 站、内置适配器、拓展）写的 `message` / `recoveryMessage` 一律平实，只说发生了什么与平台这一侧自己会怎么做，不称呼主人、不自称女仆，不写宿主的界面与操作；平台的数字错误码写进 `message`，不占 `code`。口吻与指路由宿主私聊时加工（ADR-0037 决策 15 下的 🔗、ADR-0025 决策 11 下的 🔗）。签名补全也见 ADR-0025：`reportProblem({ code, message, notify?, recoveryMessage? })` 等。
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
    🔗 **现状（3b-45，10-25）**：开发入口固定为拓展包根目录的 `devtools.mjs`，清单 `"devtools": {}` 只开口、不带路径；宿主只在开发版、拓展 `activate` 成功后调用同步导出的 `devtools(ctx)`，以拓展 id 认领并把场景 id 加前缀，停用、卸载、重载或关机即撤。场景族住 `packages/internal/src/devtools.ts`；`ExtensionDevtoolsContext` 住拓展包，比 `ExtensionContext` 只多一个现取的 `mountUrl()`。拓展参数这一版只收 `text` / `number` / `enum`。开发入口不进发行包，打包与装包白名单都不收。市场场景不预设任何拓展，默认空，要手填已装拓展 id。
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
    🔗 **2026-10-10**（3a-27，主人定）：作品的交法是**直调，不是事件**。方向：「发生了什么」用事件，「做 X」用直调 —— 来源把作品交给核心的一个入口（`PostQueue.enqueue`），没有返回值；`post-detected` 是入口发的旁路通知（给统计），不是装配的入口，没有谁靠监听它来推送。上面「按身份展开成每条订阅一份 `PostEvent`」这一步，3a-27 先由 B 站接线（按身份取订阅，遗留重复订阅只出一份）与拓展绑定各自做，核心里的展开门与 `ctx.reportPost` 归 3a-28 / 3b。
    🔗 **2026-10-11**（3a-28，B 站这一支）：展开门与 `ctx.reportPost` 已落在来源上下文（`apps/server/src/subscriptions/source-context.ts`）。`reportPost` 按身份取全部订阅（订阅仓的 `listByIdentity`），**遗留的重复订阅每条各一份** `PostEvent`（3a-27 过渡期只出先出现的那条，到此恢复；主人 10-10 定 3a-27 时已知道这一片恢复）：各推各的、统计各记各的，一条停用或关了作品开关只丢它自己那份。停用的、作品开关关着的不在 `reportPost` 里筛，由作品入口按订阅现折设置再查一次 —— 这就是上面的「核心收到上报后兜底再查一次」。名单是 `sourceSubscriptionViews` 现算的（只列启用中的订阅，同一人合成一条、`features` 取并集），这一片仍列每条启用中的订阅，含作品开关关着的人；「没开作品就不拉也不抓图」归 3a-31。两路触发（订阅变了、全局设置变了）都转成「名单可能变了」，来源自己对比。`reportLive`、`reportProfile` 这一片没造。拓展那一支仍走自己的通道，3b 并进这张登记表。
57. **主人通知只有一个口（09-27 命名审查）**：推送层的 `sendPrivateMsg` / `sendToMaster` / `sendErrorMsg` 合成 `notifyMaster(text)`；出口上的 `sendPrivate` 与「强制私聊」标志 `{ private: true }` 删掉，出口只有普通的 `send`。私聊的要求挪到选主人目标时：`master.targetId` 必须指向私聊目标（schema 校验，面板下拉只列私聊目标）；迁移时指向群目标的清空，首访页提示重选。
    - 理由：主人目标原先可以随便选；选了群目标，强制私聊会把群号当成 QQ 号去调「发私聊」，要么报错、要么错投；选的本来就是私聊目标时，这个标志又什么都不做。
    🔗 **2026-09-28**：`notifyMaster` 收文字或消息体、返回结果形状；发送时复检主人目标是私聊，把它改成群目标的 PATCH 拒收（ADR-0024 决策 14）。
    🔗 **2026-10-09**（3a-18 施工时主人定）：「强制私聊」一次删干净，适配器发送口的第四个参数与拓展契约的类型一起改，不留到适配器接口那一片。删除的正好是主人目标时**拒绝删除**并说明先换掉或清空（被否：照删并连带清空，主人可能没意识到删的是唯一的报警通道；留着悬空的 id）。校验放配置仓的四个写入口（设置保存、改目标、删目标、恢复备份），开机读盘不拒开机。备份格式版本抬到 11。

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
    🔗 **2026-10-12 守卫 11 落地（3a-41），词表自动生成只取一样**：定案写的是三样（`bilibili/` 的导出名、B 站接口客户端的方法名、B 站类型的键），主人 10-12 定只取 snake_case 的类型键 —— `bilibili/` 里接口与类型字面量的属性签名、枚举成员中全小写带下划线的名字（今天 81 个），快照进守卫文件、另配「现生成 = 快照」的断言，这样 `bilibili/` 加了新的原始字段时，红的是「快照该更新了」，不是核心里某个文件突然多一处。依据是真生成出来数的：导出名 217 个、在核心命中 128 处，其中 127 处就是守卫 1 已按 import 记着的那批引用；方法名 41 个、命中 570 处，`get` / `start` / `stop` 三个词占 538；类型的键全取命中上万处；只取核心没有同名声明的 141 个，命中的大头是核心自己的设置键，方向反了。被否：三样都取、配通用词排除表；不生成、只用手写词表（那样 `module_author`、`pub_ts`、`level_info`、`current_level`、`short_id` 这几处真越界抓不到）。代价：核心里用 `bilibili/` 导出名的地方仍只由守卫 1 按 import 语句条数记，同一个文件里把一个已 import 的名字多用几次不会红。同批开张的 uid 棘轮不扫面板、`.platform` 决定棘轮扫面板并另记一张表（主人 10-12 定）。
    🔗 **2026-10-12 守卫 21b 落成（3a-42），检查点口径改成「3a 子集绿加不开名单」**（主人 10-12 定）：定案要进程内的假来源实现完整的 `Source`（10 个成员）加一个 `AiToolProvider`，而接口上今天只有 5 个成员、`AiToolProvider` 与 `LinkResolver` 的登记表也没有。落成的是：假来源（键 `acme.inprocess`，只实现中立的 `Source`）经真入口与真 `compose.ts` 与真 B 站来源并排登记，拍 3a 子集 20 行，另 18 行列在同一个测试文件的「这版不开」名单里、逐行写明等哪一期；3a 检查点以「20 行全绿」为准，3b 出期条件加一句「名单里标 3b 的行转成对拍」。被否：3a 里先把这些口造出来给假来源实现；检查点挪到 3b。这一片对拍顺手查出并修掉核心里四处「默认来源是 B 站」的后门，另有 13 处查出而没修，留到 3b 与第 4 期（落成记录与逐项去处见 [phase-3a-plan.md](../1.0/phase-3a-plan.md)「3a-42 已落」）。
60. **归期**：第 2 期抽 `packages/http`（抓图服务建在它上面）；3a 平台适配器接口与登记表、内置适配器与模板候选、`/api/adapters`、连接与目标的新形状与迁移、`SourceContext` 的 `settings` 与 `http`、设置坏了只停那一处、推送守卫①与守卫②棘轮开；3b 契约 v3 推送侧加宽、桥迁 v3、守卫③；第 4 期面板按描述画（健康卡先出设计稿）；3b 结束时守卫②清零；第 6 期的抖音拓展是 `ctx.http` 的第一个拓展用户。
    🔗 **2026-10-03 抓图服务挪进 3a**：第 2 期里它没有调用方（旧引擎只把图链交给出图器，出图器自己抓），3a 的 `fetchImage` 挂上 ctx、B 站上报交引用才是第一个调用方，客户端也在那时才定得下来；出图器零联网与舰长图标改本地资产随之挪进 3a（见 docs/1.0/construction-plan.md 第 2 期表下「⑯ 并进 3a」）。
    🔗 **2026-10-08 出图器零联网落地（3a-37）**：渲染页的请求闸开在浏览器适配层，对每一个渲染页无条件生效（出卡、压图、示例预览、探活），只放行 `data:` —— 图库引用在进 HTML 之前就已转成 data URL，不给本机图库地址留口，也没有任何主机或协议白名单。出图器里的预取链整条删掉；只有地址没有引用的图画占位。链接预览的视频封面在这一片先抓进图库（功能本身 3b 才中立化）。
    🔗 **2026-10-12 推送守卫②开张（3a-41）**：原来没有任何一片认领它，主人 10-12 定并进 3a-41 当第四道。落成与定案字面的几处不同：词按「连续几段拼起来正好等于」匹配；`\bQQ[A-Z]` 落成「标识符与长得像标识符的字符串里有一段是 `qq`，自由文本里原样用 `\bQQ[A-Z]`」（合起来是定案的超集，「分享到 QQ」不误中）；`user_id` / `group_id` 连驼峰的 `userId` / `groupId` 一起认（主人 10-12 定；被否：只认下划线写法，那样入站形状那 51 处全盲）；**`webhook` 不进词表**（主人 10-12 定；被否：加。通用技术词，`config/store.ts` 托管 webhook 目标那套「核心认识 webhook 这一种适配器」的逻辑归 3b 的守卫③）；`bilibili/` 整目录不扫（定案没写）；`compose.ts` 整文件白名单（它造并登记三个内置适配器，那几处就是登记本身；被否：记棘轮，那一格永远清不了）。开张现数 17 个文件 147 处，其中平台表与连接设置规则 61 处要等第 4 期面板按适配器的描述画之后搬走；「3b 末清零」的字面先不改，3b 收尾时再问主人（10-12 定）。

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
- **施工时再定**（不影响架构，对着代码更好定）：`engine-error` 的中立模块名；~~直播互动走能力回调还是走总线~~（2026-10-14 主会话照规矩定：走回调、不走总线，见决策 27 下的 🔗）；现有 22 个总线事件的全量去向表。
- **进程托管协议文档**：1.0 的施工项；插件本身住各自的独立仓，真开始做时再定。

## 施工时要同步的文档

- `CLAUDE.md` 与 `docs/agents/*.md`（push、architecture、commands、events、devtools、self-update、extension-marketplace）里的过时引用，随施工第 5 期同步。
