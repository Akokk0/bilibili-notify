# @bilibili-notify/live

## 0.1.0-alpha.4

### Minor Changes

- f8f8d52: 动态推送文本模板可自定义 + 全部消息模板占位符统一 `{name}` 风格

  - 新增可自定义的动态推送文案模板(普通动态 / 视频投稿两段,变量 `{name}` / `{url}`),全局默认 + advanced-subscription 高级规则 per-UP 覆盖
  - 直播 / 上舰 / 特别关注 / 弹幕总结模板占位符从 `-name` 统一为 `{name}` 风格;渲染器同时兼容旧 `-name` 写法,已保存的旧模板继续生效
  - 直播消息模板去掉启用总开关,与动态模板一致:改了即生效(默认值等于内建文案,未编辑时输出不变)
  - 修复动态推送「有图 / 无图」两条分支文案不一致(无图分支重复前缀);per-UP 模板 override 被全局默认值污染、导致无关 override 误关联动态模板覆盖

### Patch Changes

- Updated dependencies [f8f8d52]
  - @bilibili-notify/internal@0.1.0-alpha.3

## 0.0.1-alpha.3

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

## 0.0.1-alpha.2

### Patch Changes

- 63ad20f: 跟随 `@bilibili-notify/push` / `@bilibili-notify/internal` / `@bilibili-notify/image` 的本轮 alpha bump,补齐全部 internal dependent 包的 patch 版本号。

  **为什么需要**:`.changeset/config.json` 设了 `updateInternalDependencies: "patch"`,本意是 dependent 自动 patch bump,但 pre 模式 + `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange` 组合下传播没生效,首轮 Version PR 只 bump 了 changeset 显式列出的 6 个包。结果:消费 push / internal / image 的 koishi/ 子插件(core / ai / image / live)与中间层 packages/\*(api / ai / live / storage / subscription / koishi-runtime)版本号没动 → pnpm publish 跳过 → npm 上这些子插件 tarball 仍是上一版,内嵌 deps 范围还是 `^旧-alpha.0`,实际新装时靠 prerelease caret 兜底拿到新版 transitive deps,**运行时行为变了但 npm tag 没动 + changelog 看不到**。

  显式列入本轮所有直接 / 间接 dependent,把版本号对齐,确保每个受影响的 npm 包都被重 publish 一次,changelog 完整记录。

- Updated dependencies [63ad20f]
- Updated dependencies [1942623]
  - @bilibili-notify/ai@0.0.1-alpha.1
  - @bilibili-notify/api@0.2.0-alpha.2
  - @bilibili-notify/internal@0.1.0-alpha.2
  - @bilibili-notify/image@0.0.1-alpha.2

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
