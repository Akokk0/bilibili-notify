# @bilibili-notify/image

## 0.0.1-alpha.1

### Patch Changes

- bd5f19b: 修上次发版以来积累的两个推送路径 bug:

  - **直播卡片简介 HTML 字面字符串**(`@bilibili-notify/image`):B 站 `room_info.description` 可能含 `<p>` / `<br>` 等富文本标签或 entity-encoded 形式(`&lt;p&gt;...`),JSX 文本插值会被 escape 成字面字符串。简介区域统一剥成 plain text(新增 `html-to-plain.ts` 工具,两遍解码兜底)。
  - **forward-images 走普通群消息**(`koishi-plugin-bilibili-notify` koishi/core sink):动态图集推送走 koishi `sendGroupForwardMsg` 时,NapCat 长消息 trpc 通道不稳常超时;改为按 `payload.forward` 二分,默认走普通 `send_group_msg` 多 image segment(稳),要合并转发卡片才显式 `h("message", { forward: true }, nodes)`(由 dashboard / koishi `imageGroup.forward` 控制)。

- 106b3db: `followerDisplay`(显示=true)全链路重命名 + 语义反转为 `hideFollower`(隐藏=true),对齐 `hideDesc` 命名风格。范围横跨 koishi plugin Schema 与 `@bilibili-notify/image` 的 `ImageRendererConfig` / `LiveCardProps` 公共接口,两端中间不再做桥接取反。

  **koishi-plugin-bilibili-notify-image** —— 主人迁移点:

  - yaml 字段名 `followerDisplay` → `hideFollower`,且布尔值取反。旧值 `followerDisplay: true`(默认显示)对应新值 `hideFollower: false`(默认不隐藏=显示);旧值 `followerDisplay: false`(隐藏)对应新值 `hideFollower: true`。koishi Schema 不识别旧字段名 → 升级后 yaml 里的 `followerDisplay` 被静默丢弃,新字段取默认 `false`(=显示)。**未显式改过该字段的主人无感**;显式设过 `followerDisplay: false`(想隐藏)的主人需要手动改成 `hideFollower: true`。
  - `font` 默认值从 `"sans-serif"` 改为引 `DEFAULT_CARD_STYLE.font`(`"PingFang SC, sans-serif"`),与独立端 internal 唯一默认源对齐。未显式设 font 的主人升级后默认字体会变,无 PingFang 字体的环境通过 CSS 兜底链(Microsoft YaHei / Noto Sans CJK / sans-serif)回退;如视觉不适可在 yaml 里把 `font` 设回 `sans-serif`。

  **@bilibili-notify/image**:

  - `ImageRendererConfig.followerDisplay: boolean` → `ImageRendererConfig.hideFollower: boolean`(语义反转)
  - `LiveCardProps.followerDisplay: boolean` → `LiveCardProps.hideFollower: boolean`(语义反转)

  下游使用者(`apps/server`、koishi-plugin-bilibili-notify-image)同步透传 `hideFollower`,两端不再桥接取反。

- Updated dependencies [bd5f19b]
- Updated dependencies [bd5f19b]
- Updated dependencies [bd5f19b]
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
