# Changelog

## 2.0.0-alpha.6

### Patch Changes

- 3d42a3e: 修 Koishi 端升级后子插件可能无法获取核心内部实例的问题,并收紧缺插件告警判定。

  - internal token 改为进程全局 `Symbol.for("@bilibili-notify/internal/BILIBILI_NOTIFY_TOKEN/v1")`,兼容 Koishi 升级后 duplicated `@bilibili-notify/internal` 副本导致的 symbol identity mismatch
  - dynamic / live / ai 子插件在 core service 缺失、internals 未就绪或版本不匹配时给出更明确的启动错误
  - 主插件缺 dynamic / live 子插件告警改为按有效 feature 判断,避免 disabled 订阅、显式关闭 feature、默认关闭的 live 细分特性误报
  - live 引擎特别关注进房目标 key 对齐为 `specialUserEnter`,修复该特性配置了 routing 但无法推送的问题

- Updated dependencies [3d42a3e]
  - @bilibili-notify/internal@0.1.0-alpha.5
  - @bilibili-notify/live@0.1.0-alpha.6

## 2.0.0-alpha.5

### Patch Changes

- b81039f: 为直播间 WS 增加静默 watchdog:连接建立后持续记录 heartbeat / 消息活动,超过 180 秒无活动时自动重连,避免直播监听半开后漏掉开播事件
- Updated dependencies [b81039f]
  - @bilibili-notify/live@0.1.0-alpha.5

## 2.0.0-alpha.4

### Minor Changes

- f8f8d52: 动态推送文本模板可自定义 + 全部消息模板占位符统一 `{name}` 风格

  - 新增可自定义的动态推送文案模板(普通动态 / 视频投稿两段,变量 `{name}` / `{url}`),全局默认 + advanced-subscription 高级规则 per-UP 覆盖
  - 直播 / 上舰 / 特别关注 / 弹幕总结模板占位符从 `-name` 统一为 `{name}` 风格;渲染器同时兼容旧 `-name` 写法,已保存的旧模板继续生效
  - 直播消息模板去掉启用总开关,与动态模板一致:改了即生效(默认值等于内建文案,未编辑时输出不变)
  - 修复动态推送「有图 / 无图」两条分支文案不一致(无图分支重复前缀);per-UP 模板 override 被全局默认值污染、导致无关 override 误关联动态模板覆盖

### Patch Changes

- Updated dependencies [f8f8d52]
  - @bilibili-notify/internal@0.1.0-alpha.3
  - @bilibili-notify/live@0.1.0-alpha.4

## 2.0.0-alpha.3

### Patch Changes

- ce5174a: 修 koishi 端 AI 总结 / 图片渲染在 sibling service 时序不利时静默失效的潜伏 bug。

  **现象**:升 `koishi-plugin-bilibili-notify@5.0.0-alpha.1` 后,部分用户反馈动态推送不再带 AI 点评(直播总结同源),AI 插件本身存活、日志无报错。

  **根因**:`koishi-plugin-bilibili-notify-dynamic` 与 `-live` 的 Service 类级 `inject` 只列了必需依赖 `["bilibili-notify"]`,`bilibili-notify-ai` / `-image` 是插件级 `optional` 不阻塞启动。`start()` 内通过 `this.ctx.get("bilibili-notify-ai")?.engine` 一次性把引擎引用塞进 `DynamicEngine` / `LiveEngine` 构造参数 —— 若 ai/image 子插件比当前服务**晚** ready,拿到的就是 undefined,后续推送在 engine 内 silent skip(`if (this.ai && ...)` 第一个条件失败,连 debug 日志都不打)。`e0083e2` 重构 koishi config 模型时改了主插件 `bringUp` 启动序,把这条原本不会触发的时序 race 翻成常态。

  **修复**:

  - `@bilibili-notify/dynamic` 加 `DynamicEngine.setImage(image)` 后置注入接口,与已存在的 `setAi(ai)` 对称
  - `@bilibili-notify/live` 加 `LiveEngine.setImageRenderer(renderer)`,内部把 imageRenderer 重构成 provider 模式,`WordcloudGenerator` / `RoomContext` 通过共享 `getImageRenderer()` 现取,setter 仅更新单一可变 state
  - `koishi-plugin-bilibili-notify-dynamic` 与 `-live` 改用 `ctx.inject(["bilibili-notify-ai"], cb)` / `ctx.inject(["bilibili-notify-image"], cb)` 在依赖服务 ready/卸载时分别调 setter,fork 跟随 service 生命周期自动 dispose
  - koishi 端 `toEngineConfig` 的 `aiEnabled` / `imageEnabled` 改为常量 true —— 用户开关下沉给 ctx.inject 决策,与"装了即启用"语义一致

  主人无感升级:旧版用户拿到新版,AI 总结自动恢复,无需调整任何配置。

- Updated dependencies [ce5174a]
  - @bilibili-notify/live@0.0.1-alpha.3

## 2.0.0-alpha.2

### Patch Changes

- 63ad20f: 跟随 `@bilibili-notify/push` / `@bilibili-notify/internal` / `@bilibili-notify/image` 的本轮 alpha bump,补齐全部 internal dependent 包的 patch 版本号。

  **为什么需要**:`.changeset/config.json` 设了 `updateInternalDependencies: "patch"`,本意是 dependent 自动 patch bump,但 pre 模式 + `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange` 组合下传播没生效,首轮 Version PR 只 bump 了 changeset 显式列出的 6 个包。结果:消费 push / internal / image 的 koishi/ 子插件(core / ai / image / live)与中间层 packages/\*(api / ai / live / storage / subscription / koishi-runtime)版本号没动 → pnpm publish 跳过 → npm 上这些子插件 tarball 仍是上一版,内嵌 deps 范围还是 `^旧-alpha.0`,实际新装时靠 prerelease caret 兜底拿到新版 transitive deps,**运行时行为变了但 npm tag 没动 + changelog 看不到**。

  显式列入本轮所有直接 / 间接 dependent,把版本号对齐,确保每个受影响的 npm 包都被重 publish 一次,changelog 完整记录。

- Updated dependencies [63ad20f]
- Updated dependencies [1942623]
  - @bilibili-notify/koishi-runtime@0.0.1-alpha.1
  - @bilibili-notify/ai@0.0.1-alpha.1
  - @bilibili-notify/live@0.0.1-alpha.2
  - @bilibili-notify/push@2.0.0-alpha.1
  - @bilibili-notify/internal@0.1.0-alpha.2
  - @bilibili-notify/image@0.0.1-alpha.2

## 2.0.0-alpha.1

### Patch Changes

- bd5f19b: koishi 端 config 模型整体收敛,internal 当唯一默认源。

  - `@bilibili-notify/internal` 新增 export:`DEFAULT_AI` / `DEFAULT_CARD_STYLE` / `DEFAULT_TEMPLATES` / `DEFAULT_DYNAMIC_CRON` / `DEFAULT_HEALTH_CHECK_MINUTES`。koishi 端 4 个 plugin schema 默认值全部从 internal 取,与 standalone 端默认对齐(消除「同一字段两端默认不一致」隐患)。
  - koishi/core 废弃 `internals.defaults` 与模块级 mutable holder `koishiDefaults`;`BilibiliPush.defaults` 改为 bringUp 闭包 `config.quietHours`,reload 时新 config 自然闭包进新 getter。
  - koishi/live / koishi/dynamic 折叠层统一为「per-UP override ?? plugin-config」两层,移除 `resolve(sub, defaults)` 的非必要使用(dynamic 只关心 `features.dynamic` 一字段,接 `resolveDynamicFeature` 直接取)。
  - `@bilibili-notify/live` 的 `SubItemView` per-UP 字段(`minScPrice` / `minGuardLevel` / `pushTime` / `restartPush`)改 required,adapter 层一次性折算,LiveEngine / room-session 不再二次回退。直接用 `@bilibili-notify/live` 的下游(目前仅 koishi 端)需调整 SubItemView 构造点。

  主人无感:这些都是内部收敛 + 默认源对齐,行为不变。

- Updated dependencies [bd5f19b]
- Updated dependencies [bd5f19b]
- Updated dependencies [bd5f19b]
- Updated dependencies [bd5f19b]
- Updated dependencies [106b3db]
  - @bilibili-notify/image@0.0.1-alpha.1
  - @bilibili-notify/internal@0.1.0-alpha.1
  - @bilibili-notify/live@0.0.1-alpha.1

## 2.0.0-alpha.0

### Major Changes

- a331704: monorepo 拆分后首次集中发版,清算自仓库重构(`93acb62`)以来的累积改动。业务核心独立成平台中立的 `@bilibili-notify/*` 包,Koishi 插件成为消费这套核心的薄壳;同一套核心另外支撑 Hono + React 独立端(独立端发 Docker 镜像,不在本次 npm 发布范围)。

  ### 首次发布的包

  仓库重构把原先内嵌在 Koishi 插件里的业务逻辑抽成独立包。以下核心包首次发布(`0.0.1`),koishi 插件经 npm 依赖消费它们 —— 不随插件打包,需作为独立依赖安装:

  - **`@bilibili-notify/ai`** —— AI 总结与人设核心(动态摘要、直播总结)。
  - **`@bilibili-notify/image`** —— 平台中立的通知卡片渲染核心(动态 / 直播 / 上舰 / SC / 词云)。
  - **`@bilibili-notify/dynamic`** —— 平台中立的动态轮询 / 过滤 / 渲染核心。
  - **`@bilibili-notify/live`** —— 平台中立的直播监听 / 弹幕收集 / 词云 / AI 总结核心。
  - **`@bilibili-notify/koishi-runtime`** —— Koishi 侧运行时适配层(日志 / 配置 / 服务桥接)。

  ### 破坏性变更

  - **`@bilibili-notify/internal`**:推送目标模型由「单层 PushTarget」拆为「PushAdapter(连接级)+ PushTarget(会话级)」两段式 discriminatedUnion;OneBot 适配器支持 HTTP / 正向 WS / 反向 WS 三种 transport。`@全体` 由独立 FeatureKey 改为路由修饰符(新增 `Subscription.atAll` / `atAllDefaults`,删除 `dynamicAtAll` / `liveAtAll`)。`Subscription` 移除内嵌的 `cachedProfile` / `state`。`BiliEvents` 契约变更:`subscription-changed` 改为携带 ops 数组、`plugin-error` → `engine-error`、新增 `live-viewers-changed` / `fans-refreshed`。
  - **`@bilibili-notify/storage`**:cookie 落盘改为 AES-256-GCM,旧 AES-CBC 文件不兼容,升级后需重新登录;支持注入式口令派生密钥。
  - **`@bilibili-notify/api`**:`Result<T>.data` 类型收紧为 `T | null`,反映 B 站错误码常返回空数据。
  - **`@bilibili-notify/subscription`**:`SubscriptionManager` 类与 `fromFlatConfig` / `addEntry` 等旧 API 删除,改为 `createSubscriptionStore` / `SubscriptionStore` / `diff`。
  - **`@bilibili-notify/push`**:`BilibiliPushConfig` 改名 `BilibiliPushOptions`,移除 `./types` 子模块导出,广播流程重写。
  - **Koishi 插件端**:订阅 / 高级订阅 / 推送目标的配置结构变化,升级后需按新结构重新配置。

  ### 新特性

  - per-UP 维度的 AI / 内容过滤 / 阈值覆盖;AI persona 扩展 `baseRole` / `extraSystemPrompt` 并内置预设,默认人设为首个预设「温柔女仆」。
  - `@全体` 改为路由修饰符,支持订阅级默认 + per-target 覆写。
  - 直播观看人数、粉丝增量等运行时数据的事件化上报。

  ### 修复

  大量 P0–P2 安全与健壮性修复:登录态机终态处理、WBI -352 分类、ReDoS 单源化、SSRF 加固、词云 `<script>` JSON 逃逸、原型污染防护、`withLock` 同步抛出时释放锁、cron 永久停自愈等。

  卡片渲染与推送:词云生成在 ESM 产物下报 `__dirname is not defined`(打包注入 `__dirname` shim 修复);上舰 / SC 卡片内边距统一到动态 / 直播卡片的尺度;`@全体成员` 与推送正文之间补一个空格,避免粘连。

### Patch Changes

- Updated dependencies [a331704]
  - @bilibili-notify/internal@0.1.0-alpha.0
  - @bilibili-notify/ai@0.0.1-alpha.0
  - @bilibili-notify/image@0.0.1-alpha.0
  - @bilibili-notify/live@0.0.1-alpha.0
  - @bilibili-notify/koishi-runtime@0.0.1-alpha.0
  - @bilibili-notify/push@2.0.0-alpha.0
  - koishi-plugin-bilibili-notify@5.0.0-alpha.0

## 1.0.3

### Patch Changes

- 7d01398: 修复账号失效时控制台仍显示「已登录」、整天无推送的 bug，并重构登录态管线：

  - BilibiliAPI 在响应体识别到 code -101 时通过新的 `onAuthLost` 回调通知上层
    （60 秒防抖），cookie 刷新返回 -101 时也走同一路径，不再静默重置 HTTP
    客户端。
  - 新增 `LoginStatusController` 集中管理登录态：所有 14 处 emit 收敛到
    reporter；启动期 `getMyselfInfo` 返回 -101 不再误报 LOGGED_IN；之前静默
    swallow 的异常路径也会上报。控制器只在 `(status, msg, data)` 实际变化
    时 emit，避免心跳带来的 UI 抖动。
  - 新增配置项 `loginHealthCheckMinutes`（默认 30 分钟，范围 5–180），在已
    登录态下定期 probe，运行中失效会立即翻转 UI、广播内部事件
    `bilibili-notify/auth-lost`；恢复后广播 `bilibili-notify/auth-restored`，
    让 dynamic / live 自动重启检测，无需手动重启插件。
  - live 删除手写的 3 次 retry（API 层已 retry 3 次），失败时改为 emit
    `plugin-error` 而非静默 return。
  - 新增调试命令 `bili status auth` 查看当前登录状态。
  - 控制台 UI 删除一闪而过的「登录成功」中转视图（与「已登录」重复）及无
    listener 的「重启插件」按钮。
  - `BiliLoginStatus` 枚举删除 `LOGGING_IN`（从未 emit）与 `LOGIN_SUCCESS`
    （已被 `LOGGED_IN` 取代），故 api 包按 minor 级别 bump。
  - 工具函数 `withLock` 提升到 `@bilibili-notify/internal` 供后续复用。
  - 修复 `auth-restored` 在"运行中失效 → 扫码恢复"路径下不会触发的回归：
    之前用"上一帧 status === NOT_LOGIN"作判据，但失效后用户扫码会经过
    LOGIN_QR / LOGGING_QR 中间态，导致 dynamic / live 永远收不到恢复事件
    无法重启监测；改用 sticky 的 `needsRestore` 标志解决。
  - 修复登录刚成功瞬间 controller 把 LOGIN_QR 留下的 base64 字符串作为
    `data` fallback 传给前端，导致前端访问 `data.card.face` 抛错的小问题；
    现在仅当 `snapshot.data` 形态像 card 时才沿用，前端也加了 `data?.card`
    的安全访问。
  - 整理 `UserCardInfoData` 类型：拆出 `UserCard` / `UserCardSpace` /
    `UserCardInfo` 子类型并补齐控制台 UI 实际使用的 `attention` /
    `vip.vipStatus` / `vip.label.img_label_uri_hans_static` / `space.l_img`
    字段，删除前端 settings.vue 内联的 80+ 行 workaround 类型定义。
  - 收敛 `auth-lost` 事件来源：由 api response interceptor 的
    `onAuthLost` 回调单点广播，dynamic 在 -101 分支不再重复 emit；同时
    删除 dynamic 自己的"账号未登录"私信，避免与 server-manager 节流私
    信内容重复。

- Updated dependencies [7d01398]
  - @bilibili-notify/internal@0.0.3
  - koishi-plugin-bilibili-notify@4.2.0

## 1.0.2

### Patch Changes

- 11deaba: Fix `Cannot read properties of undefined (reading 'some')` on remote
  installs by declaring `@bilibili-notify/subscription`'s runtime
  dependencies on `@bilibili-notify/api` and `@bilibili-notify/push`.

  `subscription/src` imports `LIVE_ROOM_MASTERS` from
  `@bilibili-notify/push` (a runtime value) and types from
  `@bilibili-notify/api`, but the package's `dependencies` field on npm
  was empty — a classic phantom dependency. The package only ran
  because consumers (core / live / dynamic / advanced-subscription)
  happened to install push themselves; if any consumer's `^1.0.0` range
  resolved to push@1.0.0 (which predates the `LIVE_ROOM_MASTERS`
  export, added in 1.0.1), subscription would crash at startup with
  `Cannot read properties of undefined (reading 'some')` from
  `needsLiveRoom`.

  Subscription now declares both deps explicitly via `workspace:^` so
  the published metadata pins compatible versions regardless of which
  consumer triggered installation. `api` is technically type-only at
  runtime but appears in subscription's `.d.ts` public surface, so
  declaring it avoids type-resolution errors for TS consumers too.

  All publishable packages that depend on subscription are bumped at
  the same time so updating users get a fresh resolution pass and
  existing lockfiles can no longer hold push at a
  `LIVE_ROOM_MASTERS`-less version.

- Updated dependencies [11deaba]
  - koishi-plugin-bilibili-notify@4.1.2

## 1.0.1

### Patch Changes

- 9f51aa6: Fix `roomId must be Number` crash when only non-`live` live-room features are enabled.

  After the master switch refactor the live listener fires whenever any live-room feature (`liveEnd`, `liveGuardBuy`, `superchat`, `wordcloud`, `liveSummary`, or the special user/danmaku configs) is on, but `subscription` was still resolving `roomId` only when `sub.live` was true. A configuration like `live=false` + `wordcloud=true` therefore left `roomId` empty and `tiny-bilibili-ws` rejected the listener with `roomId must be Number`.

  - `@bilibili-notify/push` — export `LIVE_ROOM_MASTERS` / `LiveRoomMaster` as the shared list of masters that imply needing the live-room WS. Used by `subscription` and `live` to stay in sync.
  - `@bilibili-notify/subscription` — `addEntry` / `loadSubscriptions` now resolve `roomId` whenever any live-room master or `customSpecial*.enable` is on. When the UP has no live room, every live-room master and both `customSpecial*.enable` flags are turned off so downstream `needsLiveMonitor` stays false.
  - `koishi-plugin-bilibili-notify-live` — `needsLiveMonitor` reuses `LIVE_ROOM_MASTERS`, and `startLiveRoomListener` rejects an empty / non-numeric `roomId` defensively instead of forwarding `NaN` to `tiny-bilibili-ws`.

- Updated dependencies [9f51aa6]
  - @bilibili-notify/push@1.0.1

## 1.0.0

### Minor Changes

- 28d9700: Centralize per-feature configuration around a single source-of-truth list and decouple every notification type into an independent sub-level master switch.

  Breaking (internal type consumers):

  - `@bilibili-notify/push` — `PushArrEntry` keys lost the `Arr` suffix (e.g. `liveAtAllArr` → `liveAtAll`) and `SubItem` now extends `SubItemMasters` so it carries 9 required master booleans (`dynamic`, `dynamicAtAll`, `live`, `liveAtAll`, `liveEnd`, `liveGuardBuy`, `superchat`, `wordcloud`, `liveSummary`). New exports: `PUSH_FEATURES`, `MASTER_FEATURES`, `PushFeature`, `MasterFeature`, `SubItemMasters`, `PushArrEntry`, `PushType.LiveEnd`.
  - `@bilibili-notify/subscription` — `FlatSubConfigItem` now extends `SubItemMasters`; consumers building it manually must include `liveEnd`.

  Behavior:

  - `koishi-plugin-bilibili-notify` — basic schema gains a `liveEnd` boolean per row (default `true`), and the AI-controlled `addSub` / `updateSub` APIs accept it.
  - `koishi-plugin-bilibili-notify-advanced-subscription` — every UP now has independent sub-level master switches for `dynamicAtAll`, `liveAtAll`, `liveGuardBuy`, `superchat`, `wordcloud`, `liveSummary`; channel rows gain a `liveEnd` toggle. A disabled sub-level master suppresses the feature for every channel, regardless of channel-level flags.
  - `koishi-plugin-bilibili-notify-live` — handler hot paths (SC card, guard card, wordcloud collection, etc.) early-return when the corresponding master+target is empty, eliminating wasted rendering. Live-end card is routed through the new `target.liveEnd`, decoupled from `target.live`. Wordcloud and live summary fire independently of `liveEnd`. The WS listener is now started whenever any live-room feature requires it (not just `live`), and incremental subscription updates re-evaluate this on every change including target-only edits.

### Patch Changes

- Updated dependencies [28d9700]
  - @bilibili-notify/push@1.0.0
  - koishi-plugin-bilibili-notify@4.1.0

## 0.1.0

### Minor Changes

- abd5015: Add SC/guard level push filters; unify wordcloud card style with other cards

### Patch Changes

- 2d08a6e: feat(image): add ADDITIONAL_TYPE_COMMON (game card) renderer; fix additional render order for AV/FORWARD types; fix FORWARD double-rendering additional; improve single image layout with 长图 badge; update reserve/goods/common button to pink rounded-rectangle style; remove arrow.png

  fix(live): fix word cloud and live summary not sent when AI is disabled

  refactor(core): move subList to core, unify bili list/ll output style, fix bili ll race condition

- beac16c: - feat(core): add AI-driven subscription management via `addSub`/`removeSub` internals and `bilibili-notify/update-config` event for config persistence
  - fix(image): correct guard level text mapping in GuardCard (舰长/总督 description was swapped)
  - style: unify all log messages to `[tag] 消息` format across all packages
  - refactor(storage): `StorageManager` now accepts `ctx: Context`; logger created from ctx and passed to `KeyManager`/`CookieStore`
  - refactor(subscription): `SubscriptionManager` now accepts `ctx: Context` directly, removing `SubLogger` interface and `SubscriptionManagerOpts`
- 76b1f79: feat(core): add `bili ai` test command to verify AI connectivity

  fix(core): remove `.required()` from AI `baseURL` schema field to allow default value; fix union fallback to `Schema.object({})` to prevent constraint errors

  refactor(push): improve push logging accuracy; only log when targets are non-empty, add debug log for empty target skip

  chore: enrich debug logging across core services (api, core, subscription, dynamic, live); route withLock errors through logger instead of console.error

- 8b6aa5a: feat(dynamic): add AI comment on dynamic push notifications

  fix(live): replace @node-rs/jieba with jieba-wasm to remove Koishi unsafe flag

  fix(live): fix stale closed snapshot in closeListener causing connections to never close on dispose

  fix(live): correct live status badge when pushed by live service

  fix(image): extend retry delay and silence errors when Puppeteer browser crashes

  fix(image): inline remote images before acquiring page to prevent idle timeout

  style(image): remove white borders and shadows from avatars for flat design

  refactor(live): extract word cloud and live summary into private methods

  refactor(logger): replace new Logger() with ctx.logger() across all services

- ef5dcfe: fix(image): inline wordcloud JS scripts to fix file:// URL blocked by Chromium in Puppeteer; fix live status badge text vertical alignment

  fix(live): update blive-message-listener to 0.5.4; use listener.closed directly (removed .live indirection)

- 40ebcbc: All bump
- 00a51a3: Code review fixes (P0/P1/P2/P3):

  - core: correct WBI `wts` timestamp; restrict `request-cors` to bilibili/hdslb hosts; switch SubItem diff to `isDeepStrictEqual`; require explicit `isReload`; reject empty cookies on login success.
  - api: drop the `cacheable-lookup` integration that was conflicting with `axios-cookiejar-support` and breaking startup; warn on cookie-refresh `-101`; correct `validateCaptcha` return type; pin ticket cron to `Asia/Shanghai`; remove unused `getCORSContent`.
  - storage: write the master key atomically (`.tmp` + rename) so a crash mid-write can no longer orphan encrypted cookies.
  - live: extract `handleLiveEnd` so polling fallback now also sends wordcloud/summary; always clear danmaku records regardless of `liveEnd`; close listener on post-init failure; scope `stopMonitoring` to a single room; wrap fire-and-forget broadcasts; narrow `INTERACT_WORD_V2` typing.
  - dynamic: advance timeline on filter-blocked items so notifications are not repeated; soft-fail image render with one-shot admin notification instead of permanently stopping the cron.
  - push: rewrite send-retry with proper online-first bot rotation, transport-error detection, and a bounded `pushArrMapReady` wait; relax `MasterConfig` shape and validate at runtime instead of casting.
  - subscription: extract `parseChannels` / `buildTargetFromFlat` / `defaultCustomFields` / `pushArrEntryFromTarget` helpers; accept explicit `isReload` flag; format `Error` messages cleanly.
  - advanced-subscription: collapse the 10 channel-flag if-blocks into a `CHANNEL_FIELDS` loop with a `satisfies` assertion.

- 2a11604: Alpha
- 921f0ad: Workspace replace
- 53b9f9b: Redesign SubscriptionOp with scoped SubChange array; add update_subscription AI tool and fix stale subs snapshot
- Updated dependencies [2d08a6e]
- Updated dependencies [beac16c]
- Updated dependencies [76b1f79]
- Updated dependencies [eeaca8f]
- Updated dependencies [8f47115]
- Updated dependencies [8b6aa5a]
- Updated dependencies [40ebcbc]
- Updated dependencies [cc1455e]
- Updated dependencies [00a51a3]
- Updated dependencies [9414097]
- Updated dependencies [2a11604]
- Updated dependencies [921f0ad]
- Updated dependencies [53b9f9b]
  - koishi-plugin-bilibili-notify@4.0.0
  - @bilibili-notify/push@0.0.2
  - @bilibili-notify/internal@0.0.2

## 0.1.0-beta.9

### Minor Changes

- abd5015: Add SC/guard level push filters; unify wordcloud card style with other cards

## 0.0.3-beta.8

### Patch Changes

- 53b9f9b: Redesign SubscriptionOp with scoped SubChange array; add update_subscription AI tool and fix stale subs snapshot
- Updated dependencies [53b9f9b]
  - koishi-plugin-bilibili-notify@4.0.0-beta.12

## 0.0.3-beta.7

### Patch Changes

- beac16c: - feat(core): add AI-driven subscription management via `addSub`/`removeSub` internals and `bilibili-notify/update-config` event for config persistence
  - fix(image): correct guard level text mapping in GuardCard (舰长/总督 description was swapped)
  - style: unify all log messages to `[tag] 消息` format across all packages
  - refactor(storage): `StorageManager` now accepts `ctx: Context`; logger created from ctx and passed to `KeyManager`/`CookieStore`
  - refactor(subscription): `SubscriptionManager` now accepts `ctx: Context` directly, removing `SubLogger` interface and `SubscriptionManagerOpts`
- Updated dependencies [beac16c]
  - koishi-plugin-bilibili-notify@4.0.0-beta.11
  - @bilibili-notify/push@0.0.2-beta.3

## 0.0.3-beta.6

### Patch Changes

- 76b1f79: feat(core): add `bili ai` test command to verify AI connectivity

  fix(core): remove `.required()` from AI `baseURL` schema field to allow default value; fix union fallback to `Schema.object({})` to prevent constraint errors

  refactor(push): improve push logging accuracy; only log when targets are non-empty, add debug log for empty target skip

  chore: enrich debug logging across core services (api, core, subscription, dynamic, live); route withLock errors through logger instead of console.error

- Updated dependencies [76b1f79]
  - koishi-plugin-bilibili-notify@4.0.0-beta.10
  - @bilibili-notify/push@0.0.2-beta.2

## 0.0.3-beta.5

### Patch Changes

- ef5dcfe: fix(image): inline wordcloud JS scripts to fix file:// URL blocked by Chromium in Puppeteer; fix live status badge text vertical alignment

  fix(live): update blive-message-listener to 0.5.4; use listener.closed directly (removed .live indirection)

## 0.0.3-beta.4

### Patch Changes

- 2d08a6e: feat(image): add ADDITIONAL_TYPE_COMMON (game card) renderer; fix additional render order for AV/FORWARD types; fix FORWARD double-rendering additional; improve single image layout with 长图 badge; update reserve/goods/common button to pink rounded-rectangle style; remove arrow.png

  fix(live): fix word cloud and live summary not sent when AI is disabled

  refactor(core): move subList to core, unify bili list/ll output style, fix bili ll race condition

- Updated dependencies [2d08a6e]
  - koishi-plugin-bilibili-notify@4.0.0-beta.9

## 0.0.3-beta.3

### Patch Changes

- 8b6aa5a: feat(dynamic): add AI comment on dynamic push notifications

  fix(live): replace @node-rs/jieba with jieba-wasm to remove Koishi unsafe flag

  fix(live): fix stale closed snapshot in closeListener causing connections to never close on dispose

  fix(live): correct live status badge when pushed by live service

  fix(image): extend retry delay and silence errors when Puppeteer browser crashes

  fix(image): inline remote images before acquiring page to prevent idle timeout

  style(image): remove white borders and shadows from avatars for flat design

  refactor(live): extract word cloud and live summary into private methods

  refactor(logger): replace new Logger() with ctx.logger() across all services

- Updated dependencies [8b6aa5a]
  - koishi-plugin-bilibili-notify@4.0.0-beta.8
  - @bilibili-notify/push@0.0.2-beta.1

## 0.0.3-alpha.2

### Patch Changes

- 40ebcbc: All bump
- Updated dependencies [40ebcbc]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.5
  - @bilibili-notify/internal@0.0.2-alpha.0
  - @bilibili-notify/push@0.0.2-alpha.0

## 0.0.3-alpha.1

### Patch Changes

- 921f0ad: Workspace replace
- Updated dependencies [921f0ad]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.3

## 0.0.3-alpha.0

### Patch Changes

- 2a11604: Alpha
- Updated dependencies [2a11604]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.2

## 0.0.2-alpha.0

### Patch Changes

- fdc2c7b: fix: move internal packages to devDependencies so they are bundled into the output
- Updated dependencies [fdc2c7b]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.1

## [0.0.1] - 2026-04-04

### Added

- 首次作为独立插件发布（原属核心包）
- 通过 WebSocket 实时监听 B 站直播间
- 开播 / 直播中 / 下播推送
- SC（超级留言）推送
- 上舰（大航海）推送
- 直播结束弹幕词云生成
- 直播结束直播总结生成
- 特别关注用户弹幕通知
- 特别关注用户进入直播间通知
- 自定义开播 / 直播中 / 下播消息模板
- 自定义上舰消息模板及舰长图片链接
- 可选接入 `bilibili-notify-image` 生成卡片图片
