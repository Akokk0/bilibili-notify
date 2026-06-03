# Changelog

## 0.1.0-alpha.5

### Patch Changes

- 3d42a3e: 修 Koishi 端升级后子插件可能无法获取核心内部实例的问题,并收紧缺插件告警判定。

  - internal token 改为进程全局 `Symbol.for("@bilibili-notify/internal/BILIBILI_NOTIFY_TOKEN/v1")`,兼容 Koishi 升级后 duplicated `@bilibili-notify/internal` 副本导致的 symbol identity mismatch
  - dynamic / live / ai 子插件在 core service 缺失、internals 未就绪或版本不匹配时给出更明确的启动错误
  - 主插件缺 dynamic / live 子插件告警改为按有效 feature 判断,避免 disabled 订阅、显式关闭 feature、默认关闭的 live 细分特性误报
  - live 引擎特别关注进房目标 key 对齐为 `specialUserEnter`,修复该特性配置了 routing 但无法推送的问题

## 0.1.0-alpha.4

### Patch Changes

- 7afd512: 修复 koishi 端订阅列表显示 UP 名称退化为 UID:订阅配置新增 `name` 字段承载用户手填昵称,普通订阅与高级订阅转换时写入,`bili list` / `bili ll` / 控制台 notifier 直接读取该字段并在缺失时回退 UID

## 0.1.0-alpha.3

### Minor Changes

- f8f8d52: 动态推送文本模板可自定义 + 全部消息模板占位符统一 `{name}` 风格

  - 新增可自定义的动态推送文案模板(普通动态 / 视频投稿两段,变量 `{name}` / `{url}`),全局默认 + advanced-subscription 高级规则 per-UP 覆盖
  - 直播 / 上舰 / 特别关注 / 弹幕总结模板占位符从 `-name` 统一为 `{name}` 风格;渲染器同时兼容旧 `-name` 写法,已保存的旧模板继续生效
  - 直播消息模板去掉启用总开关,与动态模板一致:改了即生效(默认值等于内建文案,未编辑时输出不变)
  - 修复动态推送「有图 / 无图」两条分支文案不一致(无图分支重复前缀);per-UP 模板 override 被全局默认值污染、导致无关 override 误关联动态模板覆盖

## 0.1.0-alpha.2

### Patch Changes

- 1942623: 推送 / 动态过滤 / 卡片渲染三块独立改动:

  - **@全体提醒拆为独立消息**(`@bilibili-notify/push`):atAllTargets 之前是把 `{type:"at-all"}` 段塞进卡片消息内部(`[image, at-all, " ", text]`),改为先发独立一条 `composite[{type:"at-all"}]` 再发原 payload,接收端看到的是「@全体 → 卡片 + 文字」两条独立消息。forward-images 合并转发场景一视同仁(@全体 是外层独立消息,与合并转发节点不冲突)。

  - **动态类型过滤新增图文 / 视频开关**(`@bilibili-notify/internal` + `@bilibili-notify/dynamic` + `koishi-plugin-bilibili-notify-dynamic` + `koishi-plugin-bilibili-notify-advanced-subscription`):`ContentFilters` 加 `blockDraw`(`DYNAMIC_TYPE_DRAW` 图文,新版 opus 框架下外层 type 仍为 DRAW)和 `blockAv`(`DYNAMIC_TYPE_AV` 视频投稿)。Koishi 端子插件全局过滤 + advanced-subscription per-UP 覆盖同步暴露两个开关。旧 `globals.json` 加载兼容:两字段在 schema 上带 `.default(false)`,缺字段时 zod 自动补值,不会让独立端启动 schema 校验失败。

  - **直播 / SC / 上舰卡片渲染修复**(`@bilibili-notify/image`):
    - SC 卡片右边距塌陷 — `image-renderer.ts` 的 `htmlWidth` 与卡片外框 `w-[290px]` 同步(之前是 280px,puppeteer viewport 比卡片窄 10px 导致右侧被裁)。
    - 上舰卡片长用户名挤掉舰长 logo — `guard-card.tsx` 左信息区 `flex-1` 加 `min-w-0`,CSS flex item 默认 `min-width: auto` 不会缩到比内容小,长名导致 sibling shrink-0 锚 logo 越界;`min-w-0` 让 flex-1 真正受 sibling 175px 锚约束,长 desc 走 CJK 默认换行规则。

## 0.1.0-alpha.1

### Patch Changes

- bd5f19b: `CardStyleSchema` 加 `font` / `hideDesc` / `hideFollower` 三字段(`DEFAULT_CARD_STYLE` 同步补默认值),独立端 dashboard 用户可直接编辑卡片字体与隐藏开关 —— 之前独立端 `ImageRenderer` 这三参数硬编码字面量,只有 koishi 端能通过 plugin config 配。

  `.default(...)` 让缺这三字段的老 `globals.json` 加载时被 zod 自动补全;新字段都向后兼容,不影响 koishi 端(koishi 仍通过自己的 plugin schema 配三字段,跟 internal `DEFAULT_CARD_STYLE` 对齐)。

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

- bd5f19b: koishi 端 config 模型整体收敛,internal 当唯一默认源。

  - `@bilibili-notify/internal` 新增 export:`DEFAULT_AI` / `DEFAULT_CARD_STYLE` / `DEFAULT_TEMPLATES` / `DEFAULT_DYNAMIC_CRON` / `DEFAULT_HEALTH_CHECK_MINUTES`。koishi 端 4 个 plugin schema 默认值全部从 internal 取,与 standalone 端默认对齐(消除「同一字段两端默认不一致」隐患)。
  - koishi/core 废弃 `internals.defaults` 与模块级 mutable holder `koishiDefaults`;`BilibiliPush.defaults` 改为 bringUp 闭包 `config.quietHours`,reload 时新 config 自然闭包进新 getter。
  - koishi/live / koishi/dynamic 折叠层统一为「per-UP override ?? plugin-config」两层,移除 `resolve(sub, defaults)` 的非必要使用(dynamic 只关心 `features.dynamic` 一字段,接 `resolveDynamicFeature` 直接取)。
  - `@bilibili-notify/live` 的 `SubItemView` per-UP 字段(`minScPrice` / `minGuardLevel` / `pushTime` / `restartPush`)改 required,adapter 层一次性折算,LiveEngine / room-session 不再二次回退。直接用 `@bilibili-notify/live` 的下游(目前仅 koishi 端)需调整 SubItemView 构造点。

  主人无感:这些都是内部收敛 + 默认源对齐,行为不变。

## 0.1.0-alpha.0

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

## 0.0.3

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

## 0.0.2

### Patch Changes

- 40ebcbc: All bump

## 0.0.2-alpha.0

### Patch Changes

- 40ebcbc: All bump

## [0.0.1] - 2026-04-04

### Added

- 首次发布
- `BILIBILI_NOTIFY_TOKEN` Symbol，用于内部包安全访问核心服务
