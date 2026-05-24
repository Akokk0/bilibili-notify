# @bilibili-notify/live

## 0.0.1-alpha.1

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
- Updated dependencies [bd5f19b]
- Updated dependencies [106b3db]
  - @bilibili-notify/api@0.2.0-alpha.1
  - @bilibili-notify/image@0.0.1-alpha.1
  - @bilibili-notify/internal@0.1.0-alpha.1

## 0.0.1-alpha.0

### Patch Changes

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

- Updated dependencies [a331704]
  - @bilibili-notify/internal@0.1.0-alpha.0
  - @bilibili-notify/api@0.2.0-alpha.0
  - @bilibili-notify/ai@0.0.1-alpha.0
  - @bilibili-notify/image@0.0.1-alpha.0
