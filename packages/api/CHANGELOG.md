# Changelog

## 0.2.0-alpha.3

### Patch Changes

- 6c56938: 修复直播弹幕连接预检每次被风控拦成 `-352` 的问题。B 站 `getDanmuInfo` 现已强制 wbi 签名，而 `getLiveRoomInfoStreamKey` 之前用未签名的裸请求，导致预检固定返回 `code=-352`、一路回退到直接建连：加密/受限房识别从未真正生效，且每个房间都会刷一条风控告警日志。改为走 `wbiGet` 自动附加 `wts` + `w_rid` 签名后，预检能拿到真实弹幕连接信息——普通房正常放行、受限房（无 token / 无弹幕服务器列表）才停止监测，`-352` 告警噪音消除。
- 9af0e14: 修复加密 / 付费 / 测试等受限直播间导致的无限重连刷屏。建立弹幕 WS 前先用 `getLiveRoomInfoStreamKey` 预检弹幕连接信息,B 站明确拒绝(明确的非风控错误码 / 无 token / 无弹幕服务器列表)时判定为受限房,直接停止该房间监测并告警一次,不再反复从 1s 退避重连。`code=-352` 属于常见风控 / 校验拦截,只视为预检不确定并回退到原直接建连路径,避免误杀普通房间。普通房间与临时网络失败的重连 / watchdog 行为保持不变。

## 0.2.0-alpha.2

### Patch Changes

- 63ad20f: 跟随 `@bilibili-notify/push` / `@bilibili-notify/internal` / `@bilibili-notify/image` 的本轮 alpha bump,补齐全部 internal dependent 包的 patch 版本号。

  **为什么需要**:`.changeset/config.json` 设了 `updateInternalDependencies: "patch"`,本意是 dependent 自动 patch bump,但 pre 模式 + `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange` 组合下传播没生效,首轮 Version PR 只 bump 了 changeset 显式列出的 6 个包。结果:消费 push / internal / image 的 koishi/ 子插件(core / ai / image / live)与中间层 packages/\*(api / ai / live / storage / subscription / koishi-runtime)版本号没动 → pnpm publish 跳过 → npm 上这些子插件 tarball 仍是上一版,内嵌 deps 范围还是 `^旧-alpha.0`,实际新装时靠 prerelease caret 兜底拿到新版 transitive deps,**运行时行为变了但 npm tag 没动 + changelog 看不到**。

  显式列入本轮所有直接 / 间接 dependent,把版本号对齐,确保每个受影响的 npm 包都被重 publish 一次,changelog 完整记录。

- Updated dependencies [63ad20f]
- Updated dependencies [1942623]
  - @bilibili-notify/storage@0.1.0-alpha.1
  - @bilibili-notify/internal@0.1.0-alpha.2

## 0.2.0-alpha.1

### Patch Changes

- bd5f19b: 二维码渲染收进 `LoginFlow` 默认实现:之前 koishi 端、独立端各自实现一遍 PNG 输出,现在 `@bilibili-notify/api` 的 `LoginFlow` 默认带渲染逻辑,两端共用同一份。koishi/core 的扫码登录路径相应简化,行为不变。
- Updated dependencies [bd5f19b]
- Updated dependencies [bd5f19b]
- Updated dependencies [bd5f19b]
  - @bilibili-notify/internal@0.1.0-alpha.1

## 0.2.0-alpha.0

### Minor Changes

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
  - @bilibili-notify/storage@0.1.0-alpha.0

## 0.1.0

### Minor Changes

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

## 0.0.2

### Patch Changes

- beac16c: - feat(core): add AI-driven subscription management via `addSub`/`removeSub` internals and `bilibili-notify/update-config` event for config persistence
  - fix(image): correct guard level text mapping in GuardCard (舰长/总督 description was swapped)
  - style: unify all log messages to `[tag] 消息` format across all packages
  - refactor(storage): `StorageManager` now accepts `ctx: Context`; logger created from ctx and passed to `KeyManager`/`CookieStore`
  - refactor(subscription): `SubscriptionManager` now accepts `ctx: Context` directly, removing `SubLogger` interface and `SubscriptionManagerOpts`
- 76b1f79: feat(core): add `bili ai` test command to verify AI connectivity

  fix(core): remove `.required()` from AI `baseURL` schema field to allow default value; fix union fallback to `Schema.object({})` to prevent constraint errors

  refactor(push): improve push logging accuracy; only log when targets are non-empty, add debug log for empty target skip

  chore: enrich debug logging across core services (api, core, subscription, dynamic, live); route withLock errors through logger instead of console.error

- ed0e7c9: Workspace replace
- 8b6aa5a: feat(dynamic): add AI comment on dynamic push notifications

  fix(live): replace @node-rs/jieba with jieba-wasm to remove Koishi unsafe flag

  fix(live): fix stale closed snapshot in closeListener causing connections to never close on dispose

  fix(live): correct live status badge when pushed by live service

  fix(image): extend retry delay and silence errors when Puppeteer browser crashes

  fix(image): inline remote images before acquiring page to prevent idle timeout

  style(image): remove white borders and shadows from avatars for flat design

  refactor(live): extract word cloud and live summary into private methods

  refactor(logger): replace new Logger() with ctx.logger() across all services

- 40ebcbc: All bump
- a9b2cca: Workspace replace
- 00a51a3: Code review fixes (P0/P1/P2/P3):

  - core: correct WBI `wts` timestamp; restrict `request-cors` to bilibili/hdslb hosts; switch SubItem diff to `isDeepStrictEqual`; require explicit `isReload`; reject empty cookies on login success.
  - api: drop the `cacheable-lookup` integration that was conflicting with `axios-cookiejar-support` and breaking startup; warn on cookie-refresh `-101`; correct `validateCaptcha` return type; pin ticket cron to `Asia/Shanghai`; remove unused `getCORSContent`.
  - storage: write the master key atomically (`.tmp` + rename) so a crash mid-write can no longer orphan encrypted cookies.
  - live: extract `handleLiveEnd` so polling fallback now also sends wordcloud/summary; always clear danmaku records regardless of `liveEnd`; close listener on post-init failure; scope `stopMonitoring` to a single room; wrap fire-and-forget broadcasts; narrow `INTERACT_WORD_V2` typing.
  - dynamic: advance timeline on filter-blocked items so notifications are not repeated; soft-fail image render with one-shot admin notification instead of permanently stopping the cron.
  - push: rewrite send-retry with proper online-first bot rotation, transport-error detection, and a bounded `pushArrMapReady` wait; relax `MasterConfig` shape and validate at runtime instead of casting.
  - subscription: extract `parseChannels` / `buildTargetFromFlat` / `defaultCustomFields` / `pushArrEntryFromTarget` helpers; accept explicit `isReload` flag; format `Error` messages cleanly.
  - advanced-subscription: collapse the 10 channel-flag if-blocks into a `CHANNEL_FIELDS` loop with a `satisfies` assertion.

- Updated dependencies [beac16c]
- Updated dependencies [40ebcbc]
- Updated dependencies [00a51a3]
  - @bilibili-notify/storage@0.0.2

## 0.0.2-beta.4

### Patch Changes

- beac16c: - feat(core): add AI-driven subscription management via `addSub`/`removeSub` internals and `bilibili-notify/update-config` event for config persistence
  - fix(image): correct guard level text mapping in GuardCard (舰长/总督 description was swapped)
  - style: unify all log messages to `[tag] 消息` format across all packages
  - refactor(storage): `StorageManager` now accepts `ctx: Context`; logger created from ctx and passed to `KeyManager`/`CookieStore`
  - refactor(subscription): `SubscriptionManager` now accepts `ctx: Context` directly, removing `SubLogger` interface and `SubscriptionManagerOpts`
- Updated dependencies [beac16c]
  - @bilibili-notify/storage@0.0.2-beta.1

## 0.0.2-beta.3

### Patch Changes

- 76b1f79: feat(core): add `bili ai` test command to verify AI connectivity

  fix(core): remove `.required()` from AI `baseURL` schema field to allow default value; fix union fallback to `Schema.object({})` to prevent constraint errors

  refactor(push): improve push logging accuracy; only log when targets are non-empty, add debug log for empty target skip

  chore: enrich debug logging across core services (api, core, subscription, dynamic, live); route withLock errors through logger instead of console.error

## 0.0.2-beta.2

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

## 0.0.2-alpha.1

### Patch Changes

- 40ebcbc: All bump
- Updated dependencies [40ebcbc]
  - @bilibili-notify/storage@0.0.2-alpha.0

## 0.0.2-alpha.0

### Patch Changes

- ed0e7c9: Workspace replace
- a9b2cca: Workspace replace

## [0.0.1] - 2026-04-04

### Added

- 首次发布
- WBI 签名与 Biliticket 生成及定时刷新
- Cookie 管理（tough-cookie）及自动刷新
- 二维码登录流程
- 动态列表、用户信息、直播间信息等接口封装
- 请求缓存与自动重试
