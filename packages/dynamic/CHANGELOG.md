# @bilibili-notify/dynamic

## 0.0.1-alpha.1

### Patch Changes

- bd5f19b: 动态图集开关从 `AppConfig` 顶层下移到独立的 `GlobalDefaults.imageGroup` 子段,新增 per-UP 覆盖能力。

  **@bilibili-notify/internal**(API 变更):

  - 新增 `GlobalDefaults.imageGroup: { enable, forward }`(带 `.default` 让老 `globals.json` 加载时自动补全)。
  - `Subscription.overrides.dynamic` rename 为 `Subscription.overrides.imageGroup`(per-UP 覆盖入口同步搬家)。
  - `AppConfig` 删除两顶层字段(整合进 `imageGroup`)。
  - `forward-images` payload 加 `forward: boolean` 字段(区分合并转发卡片 vs 普通多图)。
  - 老 `globals.json` 缺 `imageGroup` 时按默认值兜底,但 `Subscription.overrides.dynamic` 旧数据需要被外部迁移工具或 dashboard 重新写一遍才会落到新字段。

  **@bilibili-notify/dynamic**:`DynamicEngineConfig.imageGroup` 由扁平字段改为嵌套对象,engine 内部按 sub-level override 折叠。

  **koishi-plugin-bilibili-notify** / **-dynamic** / **-advanced-subscription**:

  - koishi 端 plugin schema 同步搬家,sub-view 透传 imageGroup。
  - advanced-subscription `customDynamic` rename 为 `customImageGroup = { enable, imgEnable?, forward? }`。
  - koishi/core/sink 的 `forward-images` 分支按 `payload.forward` 二分(`h("message", { forward: true }, nodes)` 合并转发 vs `h("message", images)` 多张图)。

  主人无感升级路径:全局 `imageGroup.enable=true, forward=false` 是默认行为,与之前 alpha 一致;想关闭图集推送或开合并转发可在 dashboard / koishi 端继续配置。

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
