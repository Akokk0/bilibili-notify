# @bilibili-notify/dynamic

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

- 1942623: 推送 / 动态过滤 / 卡片渲染三块独立改动:

  - **@全体提醒拆为独立消息**(`@bilibili-notify/push`):atAllTargets 之前是把 `{type:"at-all"}` 段塞进卡片消息内部(`[image, at-all, " ", text]`),改为先发独立一条 `composite[{type:"at-all"}]` 再发原 payload,接收端看到的是「@全体 → 卡片 + 文字」两条独立消息。forward-images 合并转发场景一视同仁(@全体 是外层独立消息,与合并转发节点不冲突)。

  - **动态类型过滤新增图文 / 视频开关**(`@bilibili-notify/internal` + `@bilibili-notify/dynamic` + `koishi-plugin-bilibili-notify-dynamic` + `koishi-plugin-bilibili-notify-advanced-subscription`):`ContentFilters` 加 `blockDraw`(`DYNAMIC_TYPE_DRAW` 图文,新版 opus 框架下外层 type 仍为 DRAW)和 `blockAv`(`DYNAMIC_TYPE_AV` 视频投稿)。Koishi 端子插件全局过滤 + advanced-subscription per-UP 覆盖同步暴露两个开关。旧 `globals.json` 加载兼容:两字段在 schema 上带 `.default(false)`,缺字段时 zod 自动补值,不会让独立端启动 schema 校验失败。

  - **直播 / SC / 上舰卡片渲染修复**(`@bilibili-notify/image`):
    - SC 卡片右边距塌陷 — `image-renderer.ts` 的 `htmlWidth` 与卡片外框 `w-[290px]` 同步(之前是 280px,puppeteer viewport 比卡片窄 10px 导致右侧被裁)。
    - 上舰卡片长用户名挤掉舰长 logo — `guard-card.tsx` 左信息区 `flex-1` 加 `min-w-0`,CSS flex item 默认 `min-width: auto` 不会缩到比内容小,长名导致 sibling shrink-0 锚 logo 越界;`min-w-0` 让 flex-1 真正受 sibling 175px 锚约束,长 desc 走 CJK 默认换行规则。

- Updated dependencies [63ad20f]
- Updated dependencies [1942623]
  - @bilibili-notify/ai@0.0.1-alpha.1
  - @bilibili-notify/api@0.2.0-alpha.2
  - @bilibili-notify/internal@0.1.0-alpha.2
  - @bilibili-notify/image@0.0.1-alpha.2

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
