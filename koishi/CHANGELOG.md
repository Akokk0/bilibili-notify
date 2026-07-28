# Changelog · koishi

npm 包 `koishi-plugin-bilibili-notify` 的版本历史。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),与独立端
`apps/CHANGELOG.md` 同一套风格。**5.0.0-alpha.9 之前**的条目由 changesets 自动生成
(`### Major/Minor/Patch Changes`,hash 写在条目开头),changesets 已弃用,旧条目原样保留、
不再回改。独立端(Docker / Desktop)版本独立维护,见 `apps/CHANGELOG.md`。

---

## [5.0.0-alpha.11] — 2026-07-28

智能女仆的模型配置整个翻新:新增**图片理解子模型**(主模型不支持看图也能让女仆读懂图片)、供应商方言适配、只显示当前供应商真正有用的设置项。同时修掉几个存在已久的问题 —— **词云在 koishi 端从 4.2.0 起就一直生成失败**,直播间可能永远卡在「直播中」,以及掉线后动态检测不停还重复报错。

⚠️ 升级前请看 **Changed**:群聊女仆的订阅管理工具已整体移除,「联网搜索」开关不再存在。

### Added

- **图片理解子模型**:配一个专门的视觉模型,它先把图片转成文字描述再交给主模型,这样**主模型本身不支持看图也没关系** —— DeepSeek 官方接口里一个视觉模型都没有,以前这条路彻底堵死。子模型有自己独立的模型名、baseURL 和 API Key(视觉模型通常在另一家)。`bili chat` 里女仆则拿到一个「看图」工具,由她自己决定哪张图值得看 (504a2a2, e30d235)
- **供应商方言与自由参数**:新增供应商选择器、深度思考开关(三档深度)、以及一个自由参数框覆盖没有专门适配的厂商 (504a2a2, e30d235)
- **只显示当前供应商有的设置**:配置页原来把所有供应商的字段一次性铺开。现在按你选的那家隐藏用不上的 —— 兜底档(自定义)不显示深度思考开关(它不发任何厂商参数,开了也是死的),DeepSeek 不显示「主模型能看图」(它家没有视觉模型,只能走上面那个子模型) (2a1884d, 1c6a65b)
- **高级订阅可以指定用哪个机器人发**:同时接了多个平台/账号时,某条订阅想固定走其中一个,不用再靠全局设置将就 (3fce7d8)

### Changed

- **群聊女仆的订阅管理工具已整体移除**,`bili chat` 现在只剩只读工具。原来女仆能帮人订阅/退订 UP,但那条路径**完全没有权限校验**(群里任何人都能让她改订阅),而且写入只落在内存里、每次重载配置就被冲掉 —— 是个看着能用、实际留不下的能力。如果你在群里靠这个加订阅,请改用配置页或 `bili` 指令 (e30d235, 504a2a2)
- **「联网搜索」开关已移除**。它原来的说明拿 SiliconFlow 举例,而那个拼法对别家都是错的;各家差异统一不了,需要的话用新的自由参数框自己写 (504a2a2, e30d235)
- **「深度思考」此前从未真正生效过**。参数被塞在 `extra_body` 里发出去 —— 那是 Python SDK 的用法,Node 客户端会把它原样序列化成一个没人认识的字段。现在参数放到请求体顶层并按供应商翻译(OpenRouter 用 `reasoning`,火山与 DeepSeek 用 `thinking`,SiliconFlow 用 `enable_thinking`)。也就是说,**一直开着这个开关的人,从这一版起才第一次真的用上它** (e30d235)
- 供应商不再从 baseURL 猜,以你选的为准 —— 猜错就意味着把 A 家的参数发给 B 家 (e30d235)

### Fixed

- **词云一直生成不出来**(报 ENOENT),这个问题在已发布的 4.2.0 里同样存在:插件是自包含打包的,而词云脚本没有被一起打进去。构建、打包、类型检查全程都是绿的,只有真去要一张词云时才炸 (9b78fc5)
- **直播间可能永远卡在「直播中」**:把状态翻成「开播」的四条路径里,只有两条挡住了竞态。走另外两条时,如果下播事件正好在这个窗口内到达,它会被丢掉,而 B 站不会重发 —— 这个房间从此永远报「直播中」 (4859656)
- **掉线后动态检测不停,还会重复报错**:直播那边掉线会停,动态检测却没有在听,它的定时任务会一直跑到自己撞上 `-101`。于是你先收到一条「账号登录已失效」,过一个轮询周期又收到一条「账号未登录」—— 同一件事,没有新信息,读起来却像又坏了一次 (e991a0a)
- **掉线后没人扫码却自己重启了一遍**:掉线瞬间有一次探活请求还在路上,它带回来的「登录正常」把状态推回了已登录 —— 于是动态检测重启、直播间重建,全部再撞一次 `-101`,并且过一会儿又推一条重复的「账号登录已失效」。现在会话一死,在途请求的结果一律作废 (4cb7bbc)
- **冷启动时登录已过期,重新扫码后监听不会自己醒过来** (5efddc9)
- **UP 名字里带 `[` 会让卡片的部分样式失效**:样式提取器把 `[` 当成任意值的开头,一路吞到下一个 `]`,中间的类名被合并成一个无效 token。名字里含中括号的 UP,卡片布局会莫名其妙地错位 (0390fec)
- 掉线时的日志现在说得清是怎么回事:原来直播那条写的是 info、措辞和正常关闭一模一样,看不出这其实是需要人去扫码的状态 (834fd68)
- `status.bot` 现在能真正报出机器人列表 (8952c7a)

---

## [5.0.0-alpha.10] — 2026-07-15

一批稳定性与正确性修复:「特别关注用户进房」终于真正生效、单项卡片样式覆盖不再串味、图文动态不再重复轰炸;默认动态轮询错开整分高峰。使用方式与配置结构均无变化,升级即可。

### Fixed

- **「特别关注用户进房」提醒终于生效** —— 这个功能从第一天起就没工作过:它依赖一份仓库里根本不存在的解码表,每次进房事件都静默失败。现在改用直播消息组件自带的进房事件,被特别关注的人进直播间会正常提醒 (ba9914b)
- 给某个 UP **单独改一项卡片样式**(例如只改渐变起始色),会把该 UP 的字体、背景图轮换、粉丝区显示等**其它全局设置一并冲回默认值** —— 最严重的是:你若在全局关掉了图片渲染,这个 UP 会被悄悄重新打开。现在单项覆盖只改那一项,其余继续跟随全局 (9c1c476)
- 图文动态(多图帖)的**附图发送失败时,主卡片连同 @全体会在之后每一轮检查里被重复推送**,直到那条动态滚出动态列表。现在附图发不出就跳过,不再连累主卡重发 (808b480)
- 停止监听某个直播间时,若恰好撞上「开播推送」正在进行,会**残留一个永不停止的「正在直播」复推定时器**,对着已经取消的订阅一直推。现在拆除时会一并清掉 (aa387a0)
- 账号被风控、进入退避等待期间,若你增删 / 开关订阅,会**提前重启动态检测、抢在退避结束前又去戳风控接口**,削弱退避的意义。现在退避期间不再被订阅变更打断 (55af1ec)
- 请求出错时错误日志会**带上完整请求 URL,其中可能含账号 CSRF 令牌等凭据** —— 报 bug 贴日志就泄漏了。现在日志只保留路径,不带查询参数 (742af30)

### Changed

- **默认**动态轮询时间从每 2 分钟的整分(:00)错开到第 30 秒(:30),避开所有人都在整分请求的高峰,降低风控概率。你若自己设过 cron 表达式则不受影响 (d2321ef)

---

## [5.0.0-alpha.9] — 2026-07-11

插件改为**自包含单文件**,装下来小了一大圈;控制台补上一条 v5 六合一的迁移提示。使用方式与配置结构均无变化,升级即可。

### Added

- 控制台新增一条**迁移提示**,讲清 v5 的六合一变更 —— 动态推送 / 直播推送 / 卡片渲染现在都是本插件的核心能力(启用即开);AI 点评与高级订阅改为配置里的开关(`ai.enabled` / `advancedSub.enabled`);**请卸载 `-dynamic` / `-live` / `-ai` / `-image` / `-advanced-subscription` 这五个旧子插件**(它们依赖的内部接口已在 v5 移除,留着也无法工作);配置已按功能域重组为八段,升级后请对照控制台重新填写一遍 (7b542f5)

  📌 **更正 alpha.8 的说明**:上一版写的是「五个插件(core / dynamic / live / ai / advanced-subscription)合并」,**漏掉了 `-image`**。实际是**六个**插件合并为一个,要卸载的旧子插件有**五个**,`koishi-plugin-bilibili-notify-image` 也在其中 —— 它同样已经无法工作,请一并卸载。

### Changed

- 插件现在是**自包含单文件产物**:九个内部 `@bilibili-notify/*` 包全部内联进去,安装时不再连带下载它们。你的 `node_modules` 里这一套从约 74MB 降到约 15MB,功能没有任何变化 (a3cd8f1)
- 从产物里移出 vue 的**运行时模板编译器** —— 卡片模板在构建期就已经编译成渲染函数了,那个编译器一行都用不上。产物再瘦约 1MB (d615b00)
- 内部 `@bilibili-notify/*` 包**不再发布到 npm**(它们已内联进插件产物)。普通使用者不受影响;⚠️ 若你有第三方代码直接 `import` 这些内部包,需要改造 (d50ae38)

---

## 5.0.0-alpha.8

### Major Changes

- 640324f: koishi 端五个独立插件(core / dynamic / live / ai / advanced-subscription)合并为单一 `koishi-plugin-bilibili-notify` 包。旧五包不再更新,请卸载后仅安装本包。

  **破坏性变更**:

  - **不再需要单独安装** `koishi-plugin-bilibili-notify-dynamic` / `-live` / `-ai` / `-advanced-subscription` —— 动态推送、直播推送现在是核心能力,随主插件启用即开,不再需要单独装子插件;AI 点评与高级订阅改为主插件 Schema 里的开关(`ai.enabled` / `advancedSub.enabled`),开了就用,不再需要单独装子插件。
  - **配置结构重新按功能域组织**,分成 `account` / `push` / `subscriptions` / `render` / `ai` / `dynamic` / `live` / `advancedSub` 八个子段。原先分散在五个插件各自 config 里的同名字段(如 `logLevel`、`cardColorStart`)现在各自归属到对应功能域,升级后需要按新结构重新配置一遍(控制台可视化编辑,不是纯 yaml 手改)。
  - **对外 API 全部内化**:原本供 dynamic/live/ai 子插件跨包访问核心 api/push/store 的 `probeInternals()` / `getInternals()` / `BILIBILI_NOTIFY_TOKEN` 探针协议整体删除 —— 单包内部直接持有引用,不再需要跨包边界的访问令牌机制。若有第三方插件依赖这套探针 API,需要改造。
  - **`bn restart` 现在会完整重建动态/直播/AI/渲染引擎**:此前这四个引擎是独立的 koishi Service,`bn restart` 只重启核心 api/push,不会刷新它们内部持有的 api/push 引用(潜伏 bug,重启后个别推送路径可能用到旧引用);现在四者与核心 api/push/store 同一生命周期,`bn restart` 会一起重建,更彻底也更符合直觉。

  **迁移建议**:先卸载 `koishi-plugin-bilibili-notify-dynamic` / `-live` / `-ai` / `-advanced-subscription`,只保留（并升级）`koishi-plugin-bilibili-notify`,再对照控制台里新的分域配置项重新填写一遍。

### Patch Changes

- ce8823b: 网络传输层从 axios 切换到基于 fetch 的实现

  补发独立端 alpha.17 已实测通过、但此前从未随 koishi 侧 changeset 发布的传输层重写(实现早已合入,只是缺 changeset,koishi 用户此前一直依赖发布于该批改动之前的旧版 `@bilibili-notify/api`,未受益于这批降风控优化):

  - 自带一个轻量 cookie jar(持久化格式与旧版兼容,升级不掉登录),逐跳捕获 Set-Cookie
  - 为每个实例生成前后一致的浏览器指纹(User-Agent 与 sec-ch-ua 版本互相咬合),减少指纹错配招致的风控
  - WBI 签名请求持续被风控时不再快速重试放大;粉丝数改用更轻量的关系接口拉取;直播间号解析结果与登录账号信息缓存复用不再重复请求
  - 移除 axios / axios-cookiejar-support / tough-cookie / jsdom / luxon 依赖

- ce8823b: 卡片版式 v2 + 每类型独立样式 + 背景图廊与轮换

  补发独立端 alpha.14~16 已验证、但此前从未随 koishi 侧 changeset 发布的整套卡片渲染升级(实现早已合入,只是缺 changeset,koishi 用户此前一直依赖发布于该批改动之前的旧版 `@bilibili-notify/image` / `live` / `dynamic` / `internal`):

  - 卡片版式描述式模型 v2:块的顺序、显隐、块间距、插入分割线可视化编辑;开播 / 动态 / SC / 上舰四种卡片改为按块类型渲染,旧版保存的版式自动迁移补齐每块间距
  - 每卡片类型可各自设置独立样式(渐变色、背景图、玻璃片透明度),未覆盖的类型继承全局基准;per-UP 亦可覆盖
  - 背景图列表模型 + 每次推送轮换下一张(开播 / 动态 / SC / 上舰各自独立游标)
  - 玻璃片透明度调节,以及与之互斥的「完全透明」开关
  - 直播卡「数据区」统一开关取代原先零散的隐藏标志
  - 充电专属动态(未充电时接口不返回正文)渲染为专门占位提示,不再是空白卡片
  - 动态卡版式细化:话题标签并入正文块顶部、附加内容独立成块、转发的内部原动态跟随同一套版式

- ce8823b: 断流接续 + 弹幕词云停用词

  补发独立端 alpha.13 已验证、但此前从未随 koishi 侧 changeset 发布的两项功能(实现早已合入,只是缺 changeset):

  - 断流接续:直播阈值新增「断流接续」开关 + 等待时长(1–10 分钟,默认 2)。开启后 UP 下播先延迟判定,等待窗口内重新开播即接续为同一场直播(弹幕 / 时长 / 词云沿用首次开播基线),用于吸收网络抖动 / 超管掐流导致的瞬时断流误报
  - 弹幕词云停用词:直播总结分类下新增停用词设置(英文逗号分隔,追加到内置中文停用词表后再分词);全局与 per-UP 覆盖均可配置

- ce8823b: 消息版式自定义

  补发独立端 alpha.16 已验证、但此前从未随 koishi 侧 changeset 发布的消息版式功能(实现早已合入,只是缺 changeset):

  动态与直播(开播 / 直播中 / 下播)推送的消息结构现可拆分 / 重排为多条消息 —— 卡片图 / 文本 / 链接三个部件可排序、显隐,插入分条符把一次推送拆成多条消息,同条内相邻文本部件的连接符可自定义;全局与 per-UP 均可配置。

- ce8823b: 一批渲染与推送稳定性修复

  补发独立端 alpha.14~17 已验证、但此前从未随 koishi 侧 changeset 发布的一批修复(实现早已合入,只是缺 changeset):

  - 开启「推送动态图集」时,一条图文动态的主卡片与图集附图会各 @ 一次全体成员;现图集附图不再重复 @,仅主卡片 @
  - 超大 B 站 CDN 图片在内联前先压缩,避免渲染超时 / 内存膨胀
  - 直播间号解析结果与登录账号信息改为缓存复用,减少重复请求

- 4953c18: 修复 master 私聊「目标不可达」的根因

  master 的推送平台与实际机器人 `bot.platform` 是两个配置源,用户常在 master 里选了 `qq`,实际跑的却是 onebot(NapCat / Lagrange / go-cqhttp 在 koishi 里平台名是 `onebot`)→ 精确匹配找不到 bot → 群能发、私聊主人却永远「不可达」。

  - **容错解析**:精确匹配(平台 + selfId)失败、且当前只有唯一在线平台时,回退用该在线 bot 投递,并打一条去重的可操作告警指出该把平台改成哪个;在线平台有多个则不瞎猜。
  - **平台字段放宽**:master `platform` 从固定下拉改为自由文本输入(文案提示 OneBot 实现应填 `onebot` 而非 `qq`)。旧配置值仍兼容。
  - **空格容错**:平台名 / selfId / channelId / userId / guildId 统一 `trim`,消除误带空格导致的静默匹配失败。
  - **启动期虚警收尾**(`@bilibili-notify/push`):新增 `recheckMasterReachability()`,在 bot 上线(`login-added` / `login-updated`)时复检 master 可达性,让启动早于 bot 连上时残留的「不可达」状态在 bot 连上后自动转为「已恢复」。

- cbf80bf: 修复 per-UP(高级订阅频道)过滤 / 调度覆盖被全局默认值污染的问题

  `overrides.filters` / `overrides.schedule` 的 partial 校验 schema 此前直接对带 `.default()` 的完整 schema 调用 `.partial()`,而 Zod 的 `.partial()` 不会剥离内层 `.default()`——频道只自定义了直播阈值(`minScPrice`/`minGuardLevel`)或调度(如 `pushTime`)时,解析结果仍会被静默注入 `blockDraw: false` / `blockAv: false` / `liveEndGrace: false` 等未填字段的默认值。当全局默认恰好为 `true` 时,这条注入的 `false` 会覆盖全局值,导致该频道的过滤 / 断流接续实际生效值与配置界面显示的不一致,且没有任何提示。现 partial schema 改为显式声明无默认的可选字段,未填字段保持 `undefined`、纯继承全局默认。

- Updated dependencies [ce8823b]
- Updated dependencies [ce8823b]
- Updated dependencies [ce8823b]
- Updated dependencies [ce8823b]
- Updated dependencies [ce8823b]
- Updated dependencies [4953c18]
- Updated dependencies [cbf80bf]
- Updated dependencies [4953c18]
  - @bilibili-notify/api@0.2.0-alpha.4
  - @bilibili-notify/internal@0.1.0-alpha.7
  - @bilibili-notify/image@0.1.0-alpha.3
  - @bilibili-notify/live@0.1.0-alpha.9
  - @bilibili-notify/dynamic@0.1.0-alpha.7
  - @bilibili-notify/push@2.0.0-alpha.2

## 5.0.0-alpha.7

### Minor Changes

- ace3790: koishi 端新增 cookieEncryptionKey 配置项:设置后用它经 scrypt 派生 AES-256 密钥,对 secrets(B 站 cookie / AI apiKey)做真正的静态加密(密钥本身不落盘),对齐 standalone 端的 BN_COOKIE_KEY;留空仍回退到原本与密文同目录的随机密钥(仅混淆)。此前 koishi 端无设置密钥的入口,只能走弱加密

### Patch Changes

- Updated dependencies [f21436c]
- Updated dependencies [57a4578]
  - @bilibili-notify/internal@0.1.0-alpha.6
  - @bilibili-notify/storage@0.1.0-alpha.2

## 5.0.0-alpha.6

### Patch Changes

- d8f7499: 为 Koishi core 与 dynamic/live/ai 子插件增加显式 internals protocol 诊断。core 现在通过 `probeInternals()` 暴露 internals 协议版本、核心包版本和未就绪原因;子插件启动时会区分 core 启动失败 / 内部实例未就绪 / token 不一致 / 协议不兼容,不再统一报“内部实例尚未就绪或插件版本不匹配”。旧的 token v1 core 若能返回 internals 仍按 v1 兼容处理。
- Updated dependencies [d8f7499]
- Updated dependencies [6c56938]
- Updated dependencies [9af0e14]
  - @bilibili-notify/koishi-runtime@0.0.1-alpha.2
  - @bilibili-notify/api@0.2.0-alpha.3

## 5.0.0-alpha.5

### Patch Changes

- 33cf104: 修复 Koishi 端勾选 SC / 舰长监听后未写入 feature overrides，导致直播插件不监听、不推送的问题。

## 5.0.0-alpha.4

### Patch Changes

- 3d42a3e: 修 Koishi 端升级后子插件可能无法获取核心内部实例的问题,并收紧缺插件告警判定。

  - internal token 改为进程全局 `Symbol.for("@bilibili-notify/internal/BILIBILI_NOTIFY_TOKEN/v1")`,兼容 Koishi 升级后 duplicated `@bilibili-notify/internal` 副本导致的 symbol identity mismatch
  - dynamic / live / ai 子插件在 core service 缺失、internals 未就绪或版本不匹配时给出更明确的启动错误
  - 主插件缺 dynamic / live 子插件告警改为按有效 feature 判断,避免 disabled 订阅、显式关闭 feature、默认关闭的 live 细分特性误报
  - live 引擎特别关注进房目标 key 对齐为 `specialUserEnter`,修复该特性配置了 routing 但无法推送的问题

- Updated dependencies [3d42a3e]
  - @bilibili-notify/internal@0.1.0-alpha.5

## 5.0.0-alpha.3

### Patch Changes

- 7afd512: 修复 koishi 端订阅列表显示 UP 名称退化为 UID:订阅配置新增 `name` 字段承载用户手填昵称,普通订阅与高级订阅转换时写入,`bili list` / `bili ll` / 控制台 notifier 直接读取该字段并在缺失时回退 UID
- Updated dependencies [7afd512]
  - @bilibili-notify/internal@0.1.0-alpha.4

## 5.0.0-alpha.2

### Patch Changes

- 63ad20f: 跟随 `@bilibili-notify/push` / `@bilibili-notify/internal` / `@bilibili-notify/image` 的本轮 alpha bump,补齐全部 internal dependent 包的 patch 版本号。

  **为什么需要**:`.changeset/config.json` 设了 `updateInternalDependencies: "patch"`,本意是 dependent 自动 patch bump,但 pre 模式 + `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange` 组合下传播没生效,首轮 Version PR 只 bump 了 changeset 显式列出的 6 个包。结果:消费 push / internal / image 的 koishi/ 子插件(core / ai / image / live)与中间层 packages/\*(api / ai / live / storage / subscription / koishi-runtime)版本号没动 → pnpm publish 跳过 → npm 上这些子插件 tarball 仍是上一版,内嵌 deps 范围还是 `^旧-alpha.0`,实际新装时靠 prerelease caret 兜底拿到新版 transitive deps,**运行时行为变了但 npm tag 没动 + changelog 看不到**。

  显式列入本轮所有直接 / 间接 dependent,把版本号对齐,确保每个受影响的 npm 包都被重 publish 一次,changelog 完整记录。

- Updated dependencies [63ad20f]
- Updated dependencies [1942623]
  - @bilibili-notify/koishi-runtime@0.0.1-alpha.1
  - @bilibili-notify/api@0.2.0-alpha.2
  - @bilibili-notify/storage@0.1.0-alpha.1
  - @bilibili-notify/subscription@2.0.0-alpha.1
  - @bilibili-notify/push@2.0.0-alpha.1
  - @bilibili-notify/internal@0.1.0-alpha.2

## 5.0.0-alpha.1

### Patch Changes

- bd5f19b: 二维码渲染收进 `LoginFlow` 默认实现:之前 koishi 端、独立端各自实现一遍 PNG 输出,现在 `@bilibili-notify/api` 的 `LoginFlow` 默认带渲染逻辑,两端共用同一份。koishi/core 的扫码登录路径相应简化,行为不变。
- bd5f19b: 修上次发版以来积累的两个推送路径 bug:

  - **直播卡片简介 HTML 字面字符串**(`@bilibili-notify/image`):B 站 `room_info.description` 可能含 `<p>` / `<br>` 等富文本标签或 entity-encoded 形式(`&lt;p&gt;...`),JSX 文本插值会被 escape 成字面字符串。简介区域统一剥成 plain text(新增 `html-to-plain.ts` 工具,两遍解码兜底)。
  - **forward-images 走普通群消息**(`koishi-plugin-bilibili-notify` koishi/core sink):动态图集推送走 koishi `sendGroupForwardMsg` 时,NapCat 长消息 trpc 通道不稳常超时;改为按 `payload.forward` 二分,默认走普通 `send_group_msg` 多 image segment(稳),要合并转发卡片才显式 `h("message", { forward: true }, nodes)`(由 dashboard / koishi `imageGroup.forward` 控制)。

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

- e600703: 主人通知对齐独立端:`MasterNotifier` 现在同时消费 `auth-lost` 与 `engine-error`。

  行为变更:

  - `engine-error` 新增主人私聊通道(per-source 60s 节流合并连串告警),warn 日志保持不变 —— 主人未配置 / push 不可达时,日志仍是可观测兜底。
  - `auth-lost` 文案与独立端统一为"账号登录已失效，请到控制台重新扫码登录"。

  内部清理:吸收 `HealthCheck` 类的 `auth-lost` 处理职责后,删除 `health-check.ts`(`LoginFlow` 内部心跳由 `packages/api` 独立维护,不受影响)。

- Updated dependencies [bd5f19b]
- Updated dependencies [bd5f19b]
- Updated dependencies [bd5f19b]
- Updated dependencies [bd5f19b]
  - @bilibili-notify/api@0.2.0-alpha.1
  - @bilibili-notify/internal@0.1.0-alpha.1

## 5.0.0-alpha.0

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
  - @bilibili-notify/api@0.2.0-alpha.0
  - @bilibili-notify/storage@0.1.0-alpha.0
  - @bilibili-notify/koishi-runtime@0.0.1-alpha.0
  - @bilibili-notify/subscription@2.0.0-alpha.0
  - @bilibili-notify/push@2.0.0-alpha.0

## 4.2.0

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

### Patch Changes

- Updated dependencies [7d01398]
  - @bilibili-notify/api@0.1.0
  - @bilibili-notify/internal@0.0.3
  - @bilibili-notify/subscription@1.0.3

## 4.1.2

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
  - @bilibili-notify/subscription@1.0.2

## 4.1.1

### Patch Changes

- bfb3d9e: Fix duplicate pushes + spurious "放弃推送" log when OneBot reports
  `retcode: 1200` for `@全体` messages.

  Two stacked bugs in `BilibiliPush.sendOnceWithRetry`:

  1. **OneBot retcode 1200 is ambiguous-success.** NapCat / Lagrange and
     similar implementations occasionally throw a non-zero retcode on
     `send_group_msg` when the payload contains `@全体`, but the message
     is actually delivered. We were treating the thrown error as a normal
     send failure, which fed bug #2.

  2. **`!onlineBot` branch conflated two cases.** When every online bot
     had been tried and all threw non-transport errors, we still went
     into the "no online bot" backoff (`sleep(delay) + triedBotIds.clear() + continue`),
     which sent the same message _again_ to the _same_ bot — and on
     retcode-1200-already-delivered this duplicated the push to the
     group N times before finally giving up after ~96s. The user-visible
     symptom was "平台 onebot 所有机器人均不可用，放弃推送" appearing
     while the message was already (multiply) in the group.

  Fixes:

  - Add `isAmbiguousSuccess(platform, err)` — when `platform === "onebot"`
    and the error message matches `/\bretcode:\s*1200\b/`, treat the
    send as successful and return without retry. Logs a warn so the
    ambiguity stays visible.
  - Split the `!onlineBot` branch by checking `hasOnlineUntried` vs
    `hasAnyOnline`. If at least one bot is online but all have been
    tried with non-transport errors, give up immediately rather than
    sleep-clear-retry. The original sleep+clear path is reserved for
    "every bot is currently offline" — the case it was originally
    designed for.

- Updated dependencies [bfb3d9e]
  - @bilibili-notify/push@1.0.2

## 4.1.0

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
  - @bilibili-notify/subscription@1.0.0

## 4.0.0

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

- eeaca8f: Fix client-side TypeScript type errors
- 8f47115: Add console client build
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
- cc1455e: Change build tool to yakumo for console
- 00a51a3: Code review fixes (P0/P1/P2/P3):

  - core: correct WBI `wts` timestamp; restrict `request-cors` to bilibili/hdslb hosts; switch SubItem diff to `isDeepStrictEqual`; require explicit `isReload`; reject empty cookies on login success.
  - api: drop the `cacheable-lookup` integration that was conflicting with `axios-cookiejar-support` and breaking startup; warn on cookie-refresh `-101`; correct `validateCaptcha` return type; pin ticket cron to `Asia/Shanghai`; remove unused `getCORSContent`.
  - storage: write the master key atomically (`.tmp` + rename) so a crash mid-write can no longer orphan encrypted cookies.
  - live: extract `handleLiveEnd` so polling fallback now also sends wordcloud/summary; always clear danmaku records regardless of `liveEnd`; close listener on post-init failure; scope `stopMonitoring` to a single room; wrap fire-and-forget broadcasts; narrow `INTERACT_WORD_V2` typing.
  - dynamic: advance timeline on filter-blocked items so notifications are not repeated; soft-fail image render with one-shot admin notification instead of permanently stopping the cron.
  - push: rewrite send-retry with proper online-first bot rotation, transport-error detection, and a bounded `pushArrMapReady` wait; relax `MasterConfig` shape and validate at runtime instead of casting.
  - subscription: extract `parseChannels` / `buildTargetFromFlat` / `defaultCustomFields` / `pushArrEntryFromTarget` helpers; accept explicit `isReload` flag; format `Error` messages cleanly.
  - advanced-subscription: collapse the 10 channel-flag if-blocks into a `CHANNEL_FIELDS` loop with a `satisfies` assertion.

- 9414097: Remove roomid from subscription config
- 2a11604: Alpha
- 921f0ad: Workspace replace
- 53b9f9b: Redesign SubscriptionOp with scoped SubChange array; add update_subscription AI tool and fix stale subs snapshot
- Updated dependencies [beac16c]
- Updated dependencies [76b1f79]
- Updated dependencies [ed0e7c9]
- Updated dependencies [8b6aa5a]
- Updated dependencies [40ebcbc]
- Updated dependencies [a9b2cca]
- Updated dependencies [00a51a3]
  - @bilibili-notify/api@0.0.2
  - @bilibili-notify/push@0.0.2
  - @bilibili-notify/storage@0.0.2
  - @bilibili-notify/subscription@0.0.2
  - @bilibili-notify/internal@0.0.2

## 4.0.0-beta.12

### Patch Changes

- 53b9f9b: Redesign SubscriptionOp with scoped SubChange array; add update_subscription AI tool and fix stale subs snapshot

## 4.0.0-beta.11

### Patch Changes

- beac16c: - feat(core): add AI-driven subscription management via `addSub`/`removeSub` internals and `bilibili-notify/update-config` event for config persistence
  - fix(image): correct guard level text mapping in GuardCard (舰长/总督 description was swapped)
  - style: unify all log messages to `[tag] 消息` format across all packages
  - refactor(storage): `StorageManager` now accepts `ctx: Context`; logger created from ctx and passed to `KeyManager`/`CookieStore`
  - refactor(subscription): `SubscriptionManager` now accepts `ctx: Context` directly, removing `SubLogger` interface and `SubscriptionManagerOpts`
- Updated dependencies [beac16c]
  - @bilibili-notify/api@0.0.2-beta.4
  - @bilibili-notify/push@0.0.2-beta.3
  - @bilibili-notify/storage@0.0.2-beta.1
  - @bilibili-notify/subscription@0.0.2-beta.2

## 4.0.0-beta.10

### Patch Changes

- 76b1f79: feat(core): add `bili ai` test command to verify AI connectivity

  fix(core): remove `.required()` from AI `baseURL` schema field to allow default value; fix union fallback to `Schema.object({})` to prevent constraint errors

  refactor(push): improve push logging accuracy; only log when targets are non-empty, add debug log for empty target skip

  chore: enrich debug logging across core services (api, core, subscription, dynamic, live); route withLock errors through logger instead of console.error

- Updated dependencies [76b1f79]
  - @bilibili-notify/api@0.0.2-beta.3
  - @bilibili-notify/push@0.0.2-beta.2
  - @bilibili-notify/subscription@0.0.2-beta.1

## 4.0.0-beta.9

### Patch Changes

- 2d08a6e: feat(image): add ADDITIONAL_TYPE_COMMON (game card) renderer; fix additional render order for AV/FORWARD types; fix FORWARD double-rendering additional; improve single image layout with 长图 badge; update reserve/goods/common button to pink rounded-rectangle style; remove arrow.png

  fix(live): fix word cloud and live summary not sent when AI is disabled

  refactor(core): move subList to core, unify bili list/ll output style, fix bili ll race condition

## 4.0.0-beta.8

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
  - @bilibili-notify/api@0.0.2-beta.2
  - @bilibili-notify/push@0.0.2-beta.1

## 4.0.0-alpha.7

### Patch Changes

- cc1455e: Change build tool to yakumo for console

## 4.0.0-alpha.6

### Patch Changes

- eeaca8f: Fix client-side TypeScript type errors
- 8f47115: Add console client build
- 9414097: Remove roomid from subscription config

## 4.0.0-alpha.5

### Patch Changes

- 40ebcbc: All bump
- Updated dependencies [40ebcbc]
  - @bilibili-notify/api@0.0.2-alpha.1
  - @bilibili-notify/internal@0.0.2-alpha.0
  - @bilibili-notify/push@0.0.2-alpha.0
  - @bilibili-notify/storage@0.0.2-alpha.0
  - @bilibili-notify/subscription@0.0.2-alpha.0

## 4.0.0-alpha.4

### Patch Changes

- Updated dependencies [ed0e7c9]
- Updated dependencies [a9b2cca]
  - @bilibili-notify/api@0.0.2-alpha.0

## 4.0.0-alpha.3

### Patch Changes

- 921f0ad: Workspace replace

## 4.0.0-alpha.2

### Patch Changes

- 2a11604: Alpha

## 4.0.0-alpha.1

### Patch Changes

- fdc2c7b: fix: move internal packages to devDependencies so they are bundled into the output

## [4.0.0-alpha.0] - 2026-04-04

### Breaking Changes

- 重构为 Yarn workspace monorepo，核心包路径变更为 `packages/core`
- 动态推送、直播推送、图片渲染拆分为独立可选插件，需单独安装
- 订阅配置格式调整，旧版订阅需重新配置

### Added

- 新增 `bilibili-notify/plugin-error` 事件，用于子插件向核心上报错误
- 控制台扫码登录 UI

### Changed

- Config 抽离至独立文件 `config.ts`，导出 `BilibiliNotifyConfig` + `BilibiliNotifyConfigSchema`
- `SubscriptionLoader` 重命名为 `SubscriptionManager`，移至 `@bilibili-notify/subscription` 包
