# Changelog · 独立端

`@bilibili-notify/server` + `@bilibili-notify/web` 独立端版本历史。Docker 镜像
`akokk0/bilibili-notify` / `ghcr.io/akokk0/bilibili-notify` 跟随 `v<VERSION>`
git tag;发布 workflow 会在构建前按 tag 临时同步 apps 版本元数据。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/);本仓库 koishi
端 `koishi-plugin-bilibili-notify*` npm 包版本独立维护,见各包 `CHANGELOG.md`。

---

## [0.2.0] — 2026-07-11

新增一键备份与恢复(完整备份 / 脱敏导出两档,恢复不需重启),订阅卡片支持右键 / 长按快捷菜单。修复一类「可选项改回默认值就存不下去」的保存故障,以及脱敏备份在配置有 QQ 官方机器人时**根本恢复不了**的问题。

### Added

- **备份与恢复**(系统页新增一节)。两档:**完整备份**把 B 站登录与 AI API Key 等机密用 6 位 PIN 加密后一并带走,换机 / 重装能原样恢复,连登录都不用重扫码;**脱敏导出**把所有机密位置留空,可以放心分享给别人。导出时按「全局设置 / 订阅 / 推送目标 / 适配器」分节勾选。导入分覆盖与合并两种模式,**覆盖前会先算出计划、把「将删除 N 项」摆到你面前确认**(删除不可撤销)。恢复后配置热重载,不需要重启 (72e1a9b, 0ae2ed8, b7c0fe6, 7653b12, c41d0be, 63313ca, c7dbaea)
- 订阅 UP 卡片支持右键(桌面)/ 长按(触屏)呼出快捷菜单:编辑详情、启用停用、复制 UID、加入分组、删除 (195d147)

### Fixed

- 「玻璃片透明度」这类可选项**改回默认值后存不下去** —— 改动会显示成「→ undefined」,保存点了没反应。现在清空一个可选字段会正确地作为「清除」提交。同类问题在卡片全局样式、per-UP 覆盖、日志级别覆盖上一并修掉 (974ed46)
- **脱敏备份恢复不回来**:配置里若有 QQ 官方机器人适配器,导入直接报 `config validation failed`。脱敏会把 appSecret 抹成空,而它此前不接受空值 —— 也就是说这个功能对用 QQ 官方机器人的人从第一天起就是坏的。现在空密钥表示「尚未填写」,可以正常存下;恢复后该适配器不会拿着空密钥去撞 QQ 网关,导入回执还会提醒你回去补填凭据 (7b6bd91)
- 批量启用 / 停用订阅之后,选中状态没有清空 (7acbdd1)
- 在卡片渲染页拖动透明度滑块时,日志会一条接一条刷出 INFO「配置已更新」,看着像是已经保存了 —— 那其实只是预览在重渲染,已降为 debug (89ca0ca)
- 日志把「清空的可选样式字段」打印成 `undefined`,现在显示为 `(默认)` (5c8714f)

---

## [0.1.0] — 2026-07-09

首个正式版,从 alpha 系列毕业。Docker 镜像大幅瘦身(自包含 bundle + chromium 基础层冻结,升级只需拉取几十 MB);修复 per-UP 高级规则「动态过滤」与「直播阈值」开关互相连带点亮的问题。

### Changed

- Docker 镜像瘦身:服务端改为自包含单文件 bundle,镜像不再携带完整 node_modules,应用层体积从数百 MB 降到约 15MB,升级时只需重新拉取这一小层 (c291631, 3359e7f, 0f766a7, d6e5aa3)
- Chromium 运行时层(约 300MB)冻结进独立基础镜像,不再随每次发版重建;今后升级只需拉取应用层,chromium 层只在显式重建基础镜像时才变化 (6d5c97d)

### Fixed

- per-UP 高级规则「动态过滤」与「直播阈值」两个开关此前共享同一份底层字段,只开其中一个另一个也会连带点亮(侧栏小点同样误标),关闭后保存草稿灵动岛还会残留;已按字段分域拆开判定,两个开关互不干扰 (e4d11ce, 8e62307)
- 服务端入口通过符号链接路径启动时(如全局链接的可执行文件、部分容器挂载路径)会静默不做任何事直接退出,不报错也不留日志;已在入口比对前对路径同样做 realpath 解析 (8e4dc6f)

---

## [0.1.0-alpha.17] — 2026-07-04

底层网络传输从 axios 全面切换到基于 fetch 的实现(自带轻量 cookie jar、每实例一致的浏览器指纹),并配套一批降低 B 站风控概率的优化(粉丝轮询解耦降频、风控熔断、请求去重复用);另修复概览页「本周推送趋势」柱状图左侧空柱与「今日推送」计数在高推送量下偏低的问题。

### Added

- 粉丝数轮询独立周期 `fansCron`(默认每 10 分钟):从动态轮询周期(`dynamicCron`)解耦、可单独调节。订阅数量多的用户不再每 2 分钟对每位 UP 各发一次请求,请求频率大幅下降,降低风控概率 (21b0280)

### Changed

- 网络传输层从 axios 切换到基于 fetch 的实现:自带一个轻量 cookie jar(持久化格式与旧版兼容,升级不掉登录),逐跳捕获 Set-Cookie;并为每个实例生成前后一致的浏览器指纹(User-Agent 与 sec-ch-ua 版本互相咬合),减少指纹错配招致的风控 (f6c3d2a, 0762c2f, ff12670, db1c068)
- 一批降低 B 站风控概率的优化:粉丝数改用更轻量的关系接口拉取、命中风控时自动暂停本轮轮询而非继续请求剩余 UP、直播间号解析结果与登录账号信息缓存复用不再重复请求、WBI 签名请求持续被风控时不再快速重试放大 (8917753, 21b0280, 92188da)

### Fixed

- 概览页「本周推送趋势」柱状图左侧总有空柱:数据源此前只取最近 100 条推送,推送量大时覆盖不满 7 天、越早的日子分到的记录越少直至为零;现改为服务端按日全量统计,并按本地时区(而非 UTC)划分日界。「今日推送 / 今日失败」计数同源修复(单日推送超 100 条时不再偏低)(4f7ebd6)

---

## [0.1.0-alpha.16] — 2026-07-03

消息版式自定义(一次推送可拆分 / 重排为多条消息)+ 充电专属动态占位渲染;修复全局默认背景图廊不轮换、镜像更新后面板仍是旧版的浏览器缓存问题。

### Added

- 消息版式自定义:动态与直播(开播 / 直播中 / 下播)推送的消息结构可视化编辑 —— 卡片图 / 文本 / 链接三个部件可排序、显隐,插入分条符把一次推送拆成多条消息,同条内相邻文本部件的连接符可自定义;全局与 per-UP 均可配置。编辑器带实时预览,并在卡片图不在消息首位时提示 QQ 会把图文拆成两条 (e669a9d)
- 充电专属动态:未充电时 B 站接口不返回动态内容,此前会渲染出正文空白的卡片;现渲染「充电专属」占位提示 (54fb032)

### Fixed

- 背景图轮换对全局默认图廊不生效:此前仅当订阅或卡片类型单独配置了多张背景时才轮换,只在全局默认样式配图廊的用户每次推送都是同一张;现全局默认图廊同样参与轮换 (ce97b1f)
- 镜像更新后面板仍是旧版:Dashboard 静态资源此前不带缓存头,浏览器会按启发式缓存旧页面,表现为「核心版本更新了但面板没更新」,需强刷或删镜像重拉才恢复;现带正确缓存策略(哈希资源永久缓存、入口文件每次回源确认)。升级到本版后首次访问仍需强刷一次,此后镜像更新面板自动跟随 (6ce4f99)

---

## [0.1.0-alpha.15] — 2026-07-02

一批稳定性与体验修复:卡片版式全局热更新补漏、独立端对畸形 cron 表达式的崩溃防护、推送路由在退避重试期间的陈旧目标复检、QQ 官方机器人连通性测试改为真实探测并新增重连日志开关。

### Added

- QQ 官方机器人适配器新增「记录重连日志」开关(默认关闭):网关 RECONNECT/RESUMED 事件约每 30 分钟一次、属正常协议行为,此前无差别刷屏,现默认静默,排障时可开启 (2141cf6)

### Fixed

- 卡片版式(块顺序 / 显隐 / 间距)只改全局版式时,已缓存的直播 / 动态订阅快照不刷新,实际推送仍用旧版式(预览始终正确,只有真实推送滞后) (32113d9)
- 独立端下播轮询周期(`app.dynamicCron`)填入无法解析的表达式会在启动时直接崩溃进程,且畸形值一旦写入磁盘,每次重启都会复现崩溃;现已加运行期防御 + 保存前校验双重兜底 (514e719)
- 订阅推送目标退避重试期间(如 OneBot 断线重连中),若用户此时把该目标从订阅里移除,重试仍会在目标恢复可达后照常发出;已取消的推送目标不再在重试窗口内复活 (0f45425)
- QQ 官方机器人连通性测试:此前基于网关 WS 在线状态判定,首次启动、握手未完成时会误报「网关连接中/失败」(实际 REST 推送通道正常),且延迟恒显示 0ms;现改为真实探测 REST 通道 (2141cf6)
- 卡片渲染配置变更日志:此前无论实际改了哪个字段,一律打印渐变色,容易被误读为改动没生效;现只打印真正变化的字段 (203a7fb)

---

## [0.1.0-alpha.14] — 2026-06-29

卡片渲染系统大升级:可视化版式编辑器、每卡片类型单独样式、背景图廊与背景轮换、玻璃片透明度,以及为单个 UP 主单独覆盖样式 / 版式 / 数据区;另含一批推送与渲染修复(动态图集重复 @全体、冷启动渲染竞态等)。

### Added

- 卡片版式编辑器:开播 / 动态 / SC / 上舰四种卡片的版式现在可视化编辑 —— 块的顺序、显隐、块间垂直间距、插入分割线,所见即所得;全局与 per-UP 均可配置(旧版保存的版式自动迁移补齐每块间距) (264ede0, bef253a, e0b0faf, 9aaf7d7, 8285b0d)
- 每卡片类型单独样式:开播 / 动态 / SC / 上舰可各自设置独立样式(渐变色、背景图、玻璃片等),未覆盖的类型继承全局基准 (6e4d8d2, c36a874, 1c8a0e9, 24d88f3)
- per-UP 卡片覆盖:可为单个 UP 主单独覆盖卡片样式与版式,叠加在全局之上;不覆盖则继承全局 (3965102, 5d01f4e)
- 卡片背景图廊:上传自定义背景图、多选图廊管理、删除时保护仍被某卡片样式引用的图;背景以列表存储,存量单图配置自动迁移 (66be478, 1818cf8, 360170e, 1e869be, aa6b356, 3c1511b)
- 背景轮换:为某类卡片配置多张背景时,每次推送轮换使用下一张(开播 / 动态 / SC / 上舰各自独立游标) (b95ae44, 3807e16, 2ac3c45)
- 玻璃片透明度调节,以及「完全透明」开关(去磨砂模糊、底图清晰透出,与透明度互斥) (d550ea2, 39a95d9)
- 直播卡「数据区」开关:用统一的数据区控制取代原先零散的隐藏标志,可整体控制人气 / 分区 / 粉丝数等的显隐,全局与 per-UP 均可配置 (b80ed0b, f822dbd)
- 卡片预览增强:per-UP 作用域用该 UP 的真实数据渲染预览(开播按 uid 拉取、动态可选「第几条」),SC / 上舰预览把接收方渲染成真实的该 UP;真实拉取失败时自动回退示例数据 (0108e43, 0e967f3, ea7f22a, eeb63a0)
- 动态卡版式细化:话题标签并入正文块顶部、附加内容(预约等)独立成块、转发的内部原动态跟随同一套版式渲染 (8e9230f, 2ac9ee8, 2391330)

### Fixed

- 动态图集重复 @全体:开启「推送动态图集」时,一条图文动态的主卡片与图集附图会各 @ 一次全体成员;现图集附图不再重复 @,仅主卡片 @ (49ebe14)
- 卡片渲染冷启动竞态:服务器刚启动、puppeteer 浏览器尚未热身时,多张卡片并发渲染会把同一张卡平铺成 2×2 并裁切;现已将渲染串行化,彻底消除竞态 (e3e8b52)
- @全体 不再阻塞卡片与后续推送:无管理权限的群发 @全体 被协议端拒绝并重试时,不再拖住卡片正文与推送队列,@全体 改为即发不等待、失败仅异步记入历史 (5783940)
- 超大 B站 CDN 图片在内联前先压缩,避免渲染超时 / 内存膨胀 (b09ef4c)
- Desktop 桌面端:外链改用系统浏览器打开,右键菜单在 Tauri 外壳内正常工作 (35a0959, 61e875d)
- 关于页赞助者名单文案订正:由「每日自动同步」改为「每次发布新版本时同步」,与实际 CI 机制一致 (fb2132f)

---

## [0.1.0-alpha.13] — 2026-06-23

弹幕词云停用词入口 + 断流接续(下播延迟判定)。版本号从 `alpha.11` 直接跳到 `alpha.13`:原拟毕业的 `0.1.0` 正式版暂缓,其内容降级为下方 `alpha.12`(不单独打 tag,改动随本次 `alpha.13` 镜像一并发布)。

### Added

- 弹幕词云停用词配置入口:高级规则「直播总结」分类下新增停用词设置(英文逗号分隔,追加到内置中文停用词表后再分词),全局与 per-UP 覆盖均可配置 (12a6788)
- 断流接续:直播阈值新增「断流接续」开关 + 等待时长(1–10 分钟,默认 2)。开启后 UP 下播先延迟判定,等待窗口内重新开播即接续为同一场直播(弹幕 / 时长 / 词云沿用首次开播基线),用于吸收网络抖动 / 超管掐流导致的瞬时断流误报;全局与 per-UP 均可配置 (879994d)

---

## [0.1.0-alpha.12] — 2026-06-22

汇总 `0.1.0-alpha.11` 以来的改动。原拟作为 `0.1.0` 正式版首发(从 alpha 毕业),现暂缓毕业、继续 alpha 迭代。

### Added

- 「关于」页:赞助者名单(随独立端发版构建时从爱发电同步生成静态文件)、更新日志、项目信息三个分区 (01b443e, e8a8116, 3737336)
- 响应式分区导航 SectionNav:顶部 tab 支持左右箭头滚动并隐藏原生滚动条,窄屏不再折叠 (ea0c407, e620414)

### Changed

- 概览「今日」统计改为按**本地时区** 0 点计算 —— 凌晨时段的推送不再被 UTC 日界算到昨天,并新增「今日失败」数 (f31efe6)
- QQ 官方机器人:订阅里「@全体」开关在 QQ 官方目标上禁用并提示「不支持」(后端本就 best-effort 跳过该平台的 @全体,避免用户误以为会生效) (5631863)
- 移除未使用的 web-dashboard 推送平台:存量配置中的该类适配器 / 目标在加载时自动清理,不影响其它推送目标 (b91cc7b)

### Fixed

- iPad / 窄屏顶部 tab 折叠:Targets / Rules / Logs 改用 SectionNav,并把 sticky tab 锚定到实测表头高度消除滚动漂移;Rules「添加 UP」下拉不再被顶栏遮挡 (d900bc3, 756d6fc, 5ed4f31)
- 更新日志 tab 切换时的高度抖动 (a7823c4)
- 日志运行区随页面滚动,与更新日志一致 (3d5ffa7)
- 推送历史失败行对齐:失败标记改为内嵌,行不再错位 (1557988)

---

## [0.1.0-alpha.11] — 2026-06-19

### Added

- 新增 QQ 官方机器人(q.qq.com)推送平台:Targets 页配置适配器(appId / appSecret / 沙箱开关 / 公私域 botType),按会话 scope 寻址(频道 guildId+channelId / 群 groupOpenid / C2C userOpenid),内置会话发现选择器(读已捞 openid 列表自动发现 + 手动枚举子频道);私域机器人图集走 markdown 图文合并,媒体内容与卡片图合并下发 (db2a48c, c352baa, d60290f)
- Dashboard 暗色模式:支持明 / 暗主题切换,全站配色语义 token 化,卡片描边 / 头像环 / Targets / Cards 等内联硬编码色同步适配暗色 (3f6a398, 4cb1e49, 1383fc3)

### Fixed

- dev / 12-factor(legacy)模式下自动探测 Chrome 并一键热启用卡片渲染后,`chromePath` 现也写回 cwd 的 `bn.config.{yaml,yml,json}`,下次启动直接复用、无需重新探测(纯 env / cli 无配置文件时仍不写回)(f5e0777)
- 历史记录列表对 @全体提醒、弹幕词云两类无正文推送不再显示「(无内容)」:@全体段落写「@全体」、词云写「[弹幕词云]」,与图集 `[图集 N 张]` 同一思路(仅作用于新写入记录)(ac619f4)

---

## [0.1.0-alpha.10] — 2026-06-15

### Added

- 卡片渲染未配置 Chrome 时，预览区新增「自动探测 Chrome」按钮：探测本机常见安装位置，命中后一键热启用卡片渲染（运行时构造 puppeteer 注入 live / dynamic 引擎）并写回 `bn.config.yaml`，无需重启 (5f56201)

### Changed

- 高级规则的 per-UP 覆盖编辑接入草稿灵动岛：编辑某个 UP 的覆盖项时，未保存改动汇总到底部灵动岛统一保存 / 丢弃，与全局规则一致，移除页内独立的保存 / 丢弃按钮 (8cc9bfb)

### Fixed

- 窄视口（iPad / 缩小窗口）下日志页布局坍缩：将渐入动画的残留 transform 与 sticky 侧栏解耦，避免侧栏在单列布局下覆盖日志内容 (1f03a21)

---

## [0.1.0-alpha.9] — 2026-06-11

### Fixed

- 加密 / 付费 / 测试等受限直播间不再无限重连刷屏：建立弹幕 WS 前先预检弹幕连接信息，B 站明确拒绝（明确的非风控错误码 / 无 token / 无弹幕服务器列表）时判定为受限房并停止该房间监测、仅告警一次；普通房间与临时网络失败的重连 / watchdog 行为保持不变 (9af0e14, 77f26f2)
- 直播弹幕连接预检补上 wbi 签名：B 站 `getDanmuInfo` 现已强制 wbi 签名，此前未签名的预检请求固定被风控拦成 `-352`、一路回退空转，现改为附加 `wts` + `w_rid` 签名后预检真正生效、受限房识别归位、`-352` 告警噪音消除 (6c56938)
- `-352` 等风控 / 校验拦截只视为预检不确定并回退到直接建连，避免误杀普通房间 (77f26f2)
- Dashboard 删除推送目标时同步清理订阅 routing / @全体引用，避免残留指向已删除目标的无效配置 (77f26f2)

---

## [0.1.0-alpha.8] — 2026-06-06

### Added

- Webhook 推送支持钉钉 / 飞书 / 企业微信机器人 provider；Generic 模式保持旧 JSON envelope,平台机器人按文本消息协议发送,非文本通知沿用文字摘要降级 (bd8effc)

### Changed

- Webhook adapter 保存 URL 后自动维护默认投递目标,订阅页可直接选择,无需手动新建 PushTarget (bd8effc)
- Webhook adapter「测试」改为真实发送测试推送,并回写 adapter / target 最近测试状态 (bd8effc)

### Fixed

- 禁止外部手动创建 / 修改 / 删除 Webhook 托管目标；删除 Webhook adapter 时同步清理订阅 routing / @全体引用,避免残留无效 target (bd8effc)
- Webhook 平台业务响应解析与错误脱敏补强:解析钉钉 / 飞书 / 企业微信业务码,错误返回和日志不泄漏 webhook URL、key、secret、sign、token (bd8effc)

---

## [0.1.0-alpha.7] — 2026-06-01

### Added

- Docker 镜像同步发布到 GHCR:`ghcr.io/akokk0/bilibili-notify`,tag 与 Docker Hub 保持一致

### Fixed

- 兼容旧版 / 手写 `bn.config.yaml` 缺少 `webDistDir` 的 Docker 配置:配置未写时先回退 `BN_WEB_DIST`,再检查镜像默认 `/app/web-dist/index.html`,避免控制台 `GET /` 返回 404
- Docker compose / config 示例补齐 `webDistDir` 说明,部署文档强调只挂载目录并让容器首次启动自动生成配置
- Desktop 发布链路补强:恢复 macOS 图标、保护 loopback dashboard、退出时清理 Node sidecar、Windows 打开动作避开 shell、精简 runtime staging、固定内置 Node 版本并检查产物内容

### Build

- Docker builder 不再执行 `changeset version`,避免独立端镜像构建在 changeset 后重装依赖阶段卡住

---

## [0.1.0-alpha.6] — 2026-05-30

### Added

- 日志页新增「运行日志 / 更新日志」二级导航,更新日志按需加载 `apps/CHANGELOG.md` 渲染 (0cf1e32)

### Changed

- 概览页各模块卡片不再显示模块版本号,仅保留系统状态里的核心 / 面板版本 (0cf1e32)

### Fixed

- 直播 WS 连接静默半开后自动自愈:超过 180 秒无心跳 / 消息活动会重连,连接关闭也统一进入重连流程,避免长时间漏开播推送 (b81039f)
- 动态接口返回字符串或缺失 `pub_ts` 时不再整条跳过:数字字符串按发布时间处理,毫秒时间戳归一化为秒,缺失时尝试解析 `pub_time` 兜底 (0ed9d98)

### Build

- Docker 构建上下文保留 `apps/CHANGELOG.md`,确保更新日志页在镜像内可正常打包

---

## [0.1.0-alpha.5] — 2026-05-28

### Added

- 动态推送文案模板可自定义:Rules 页「动态消息模板」全局编辑 + 高级规则 per-UP 覆盖,
  普通动态 / 视频投稿两段独立,变量 `{name}`(UP 名)/ `{url}`(链接,关闭附带 URL 时为空)
  (5eb594a)

### Changed

- 直播消息模板去掉启用开关,与动态模板一致 —— 改了即生效;默认值等于内建文案,
  未编辑时推送输出不变 (c88bb52)
- 直播 / 上舰 / 特别关注 / 弹幕总结模板占位符统一为 `{name}` 风格,变量提示同步修正
  (删掉渲染器不提供的 `{title}`、`{duration}`→`{time}`、补 `{follower}`/`{follower_change}`、
  上舰改 `{uname}`/`{mname}`/`{guard}`);老 `-name` 写法仍兼容 (5eb594a)

### Fixed

- 动态推送「有图 / 无图」两条分支文案不一致:无图分支重复前缀(`X发布了一条动态：X发布了
  一条动态：…`),现统一走同一模板渲染 (5eb594a)
- per-UP 模板 override 被全局默认值污染:只改了某一项模板(如直播总结)的 UP 会被误判为
  自定义了动态模板,从而停止跟随全局动态模板、面板误标「已定制」(0c50955)
- 改全局动态模板后未热重载,无 per-UP 覆盖的订阅仍用旧模板;新增订阅的 per-UP
  覆盖(过滤 / 图集 / 模板)首次推送丢失,需等下次刷新 (17f0412)

---

## [0.1.0-alpha.4] — 2026-05-27

### Added

- 灵动岛草稿机制:Rules / Cards / Ai / System 四页修改字段时,屏幕底部漂浮 chip
  统一显示「页名 + 未保存字段数 + 保存」按钮,hover / click 展开后按 section 分组
  的字段级 diff list(旧值 → 新值),点单行跳转高亮目标 Field,左下「丢弃全部更改」
  一键回滚。chip 5 态:idle 不显示、dirty(待保存)、saving(保存中 spinner)、
  saved(✓ 1.2s 自动消失)、error(摇晃 + 红边 pulse 需手动 dismiss)。dirty 态
  chip 外圈 2px 粉色单弧流光环绕岛旋转 2.4s/圈。AiBar dismissed / expanded 时灵
  动岛垂直避让(4fcd59f..af13f66)

### Fixed

- 独立端 dashboard 修改全局 ai persona / cardStyle 后 dynamic 推送不跟随 hot-reload,
  仍用 add 订阅时的旧值(直播端因 refreshOps 不受影响);`buildDynamicSubsView` /
  `buildLiveSubViewSingle` 改为仅在 `sub.overrides.cardStyle` / `.ai` / `.filters`
  真存在时生成对应字段,推送路径回退到 `imageRenderer.config` / `commentary.config`
  全局兜底 (5bdedcc)
- 保存 AI 配置时,即便只改 persona / 温度 / 提示词也会触发连通性探活,导致按钮卡
  10s;后端 `shouldRunAiEnableCheck` 加值对比,patch 含连接字段但值跟 current 相同
  时不触发 (0395404)

---

## [0.1.0-alpha.3] — 2026-05-26

### Added

- @全体提醒拆为独立消息(@全体 → 卡片 → 文字三条),Koishi 主插件、advanced-subscription
  per-UP 覆盖、独立端 globals.@全体规则同步暴露 (f427278)
- 动态过滤新增「图文」「视频」两个屏蔽开关 (f427278)

### Fixed

- SC 卡片右侧文字贴边塌陷 (f427278)
- 上舰卡片长用户名挤掉舰长 / 提督 / 总督 logo (f427278)
- 直播卡片简介里 `<p>` / `<br>` 等富文本残片改为去标签纯文本(独立端镜像 image
  渲染路径同步生效)

### Build

- image-release workflow 5 个 inline shell step 提到脚本文件 (28b1e4e)
- 修复 codex audit 抓出的 7 类 CI 安全 / 一致性问题(包括 RELEASE_PAT 注入路径 /
  tag commit 鉴权 / merge job 串行化等)(22dce62)
- pnpm 11.1.3 → 11.3.0,docker / setup actions 升到最新版 (22854f5)
- arm64 镜像 build cache mode=max → mode=min,绕开 GHA cache export hang (7da55c6)
- tag push 鉴权改 basic auth,兼容 fine-grained PAT(`github_pat_*` 上不支持 bearer)
  (81a274e)

---

## [0.1.0-alpha.2] — 2026-05-24

### Added

- MasterNotifier 同步消费 `auth-lost` 与 `engine-error`,主人通知文案对齐独立端 (e600703)
- image-release workflow 自动创建 GitHub Release 挂在 `v<version>` tag 下 (87a1232)

### Fixed

- onebot 合并转发 node 用 bot 真身的 uin / nickname,而非订阅 master 假名 (f47810e)
- onebot forward send 先校验 target,latency 计入 `get_login_info` (db8ef70)

### Build

- image-release workflow build 拆 matrix(amd64 / arm64 各原生 runner)+ digest
  merge 替代 emulation,大幅缩短 arm64 镜像构建时间 (5cfbb89)
- docker actions 升到 v4/v7,checkout 升到 v6 (5ed8382)
- builder 阶段插 `vp --version` / `vp env doctor` 诊断输出 (74901a4)
- 显式 `pnpm install --no-frozen-lockfile` + `pnpm -r build` 拆两阶段 + `--stream`
  便于定位 hang (2a4d110, c41de2a)
- tag push + release 创建走 `secrets.RELEASE_PAT`(workflow `GITHUB_TOKEN` 没有
  workflow scope 写权)(8311a67)
- docker pull 命令省 `docker.io/` 前缀 (49a2805)

---

## [0.1.0-alpha.1] — 2026-05-24

### Added

- 独立端 cards 配置补齐 `font` / `hideDesc` / `hideFollower` 三字段(对齐 koishi
  image 子插件 schema)(7022322)
- 动态图集开关独立成 `imageGroup` 子段,支持 per-UP 覆盖 (ca47fe6)

### Changed

- 二维码渲染收进 `LoginFlow` 默认实现,koishi 端 / 独立端不再各自实现一遍 PNG 输出
  (7d32e87)
- koishi 端 config 模型整体收敛,internal 当唯一默认源;packages/internal 同步
  export `DEFAULT_AI` / `DEFAULT_CARD_STYLE` / `DEFAULT_TEMPLATES` 等(独立端通过
  共用 packages/internal 间接受益)(e0083e2)
- 直播卡片 `room_info.description` 富文本(`<p>` / `<br>` / entity-encoded)统一剥
  成 plain text(`html-to-plain.ts`)(77bbc77)
- forward-images sink 走 `payload.forward` 二分:默认普通群消息多 image segment
  (稳),显式合并转发节点(`h("message", { forward: true }, nodes)`)(5c632f7)
- 动态图集推送改用合并转发消息形态 (c3ee457)

### Fixed

- dashboard 未启用鉴权时误弹 LoginDialog 且走不出去 (22cb87e)
- onebot 错误响应加 NapCat 掉线提示文案 (dfb4388)
- onebot 私聊 scope target 报「group: groupId missing」(77b9b37)

### Breaking Changes

- `image` 子插件 `followerDisplay` 字段重命名为 `hideFollower` 并反转语义
  (`followerDisplay: true` → `hideFollower: false`)(106b3db, b9aaba6)
- `GlobalDefaults.imageGroup` 新子段:
  - 新增 `imageGroup: { enable, forward }`(老 `globals.json` 缺字段时按默认值兜底)
  - `Subscription.overrides.dynamic` 重命名为 `Subscription.overrides.imageGroup`
    (旧数据需外部迁移或 dashboard 重写一次)
  - `AppConfig` 删除原顶层两字段
  - `forward-images` payload 加 `forward: boolean` 区分合并转发卡片 vs 普通多图
  - 详见 ca47fe6

### Build

- 镜像 push 成功后自动打 git tag `v<version>` (dfdcb6f)
- `.dockerignore` 排除 `**/*.md` 误杀 changeset 文件 (1be8d4c)

---

## [0.1.0-alpha.0] — 2026-05-22

### Added

- monorepo 拆分后独立端首次镜像。业务核心独立成平台中立的 `@bilibili-notify/*`
  包,独立端通过 `apps/server` 消费这套核心,经 puppeteer + Hono 提供 HTTP API +
  WebSocket,`apps/web` (React 19 + Vite) 内嵌进同一镜像
- 独立端版本由 `apps/server/package.json#version` 驱动(本次起为 `0.1.0-alpha.0`),
  bump 后 push 到 dev 触发 image-release workflow 自动构建 + push Docker Hub +
  打 git tag + 创建 GitHub Release (9b7bb75)
