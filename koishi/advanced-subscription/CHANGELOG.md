# Changelog

## 3.0.0-alpha.0

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
  - koishi-plugin-bilibili-notify@5.0.0-alpha.0

## 2.0.1

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

## 2.0.0

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

## 1.0.0

### Patch Changes

- c6300b8: workspace replace test
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

## 1.0.0-alpha.4

### Patch Changes

- 40ebcbc: All bump
- Updated dependencies [40ebcbc]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.5
  - @bilibili-notify/push@0.0.2-alpha.0

## 1.0.0-alpha.3

### Patch Changes

- c6300b8: workspace replace test

## 1.0.0-alpha.2

### Patch Changes

- 2a11604: Alpha
- Updated dependencies [2a11604]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.2

## 1.0.0-alpha.1

### Patch Changes

- fdc2c7b: fix: move internal packages to devDependencies so they are bundled into the output
- Updated dependencies [fdc2c7b]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.1

## [1.0.0-alpha.0] - 2026-04-04

### Breaking Changes

- 重构为 monorepo 子包，Config 抽离至 `advanced-subscription.ts`
- 插件入口 `apply` 由 `applyAdvancedSub` 提供，`index.ts` 重新导出为 Koishi 标准格式

### Added

- 每个 UP 主独立配置推送平台和频道列表
- 每个频道可单独开关：动态、动态@全体、直播、开播@全体、SC、上舰、词云、直播总结、特别关注弹幕、特别关注进场
- 自定义直播消息模板（开播 / 直播中 / 下播）
- 自定义直播总结模板
- 自定义上舰消息模板及舰长 / 提督 / 总督图片链接
- 自定义推送卡片渐变颜色和底板颜色
- 特别关注弹幕用户列表及消息模板
- 特别关注进入直播间用户列表及消息模板
