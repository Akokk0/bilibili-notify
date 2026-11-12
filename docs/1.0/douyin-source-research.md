# 6-06 抖音订阅源调研

2026-11-12 核对 kkk 2.45.3 及该提交固定的 Amagi 7.0.0-beta.9 源码。kkk 负责订阅、推送和与人的交互，抖音网页请求与响应判定在 Amagi。主人已确认抖音首版的常用操作与系统扫码登录对齐 B 站。[kkk 源码快照](https://github.com/ikenxuan/karin-plugin-kkk/tree/e97c1c8b6da19d6e8159f2314ab2c87e888c265e) · [Amagi 源码快照](https://github.com/ikenxuan/amagi/tree/094238d5d5f8c20abba5c3e5c7d03741190e2ab1) · [首版定案](../adr/0047-douyin-source-parity.md)

## 可用的接口线索

抖音开放平台的作品列表需要创作者授权。BN 的使用者希望订阅自己关注的公开作者，一份观看账号的授权不能代替各创作者授权。kkk 使用的是抖音网页和分享页接口，签名与返回字段需要随网页变化复验。[抖音开放平台作品列表](https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/search-video/account-video-list) · [抖音登录与授权](https://developer.open-douyin.com/docs/resource/zh-CN/dop/ability/user-authorization/solution)

| 订阅动作 | kkk / Amagi 使用的接口与字段 | BN 拟用方式 |
| --- | --- | --- |
| 粘作者主页或分享链接 | 主页 `www.douyin.com/user/<sec_uid>`、分享页 `www.iesdouyin.com/share/user/<sec_uid>`。kkk 展开短链后再分作者、作品、直播间。[链接识别](https://github.com/ikenxuan/karin-plugin-kkk/blob/e97c1c8b6da19d6e8159f2314ab2c87e888c265e/packages/core/src/platform/douyin/getID.ts#L22-L51) · [主页路径](https://github.com/ikenxuan/karin-plugin-kkk/blob/e97c1c8b6da19d6e8159f2314ab2c87e888c265e/packages/core/src/platform/douyin/getID.ts#L85-L115) | 直接从主页取字符串 `sec_uid` 作 `externalId`，再核对作者资料。输入也可给原始 `sec_uid`。分享文本只提取抖音 HTTPS 链接，`v.douyin.com` 短链逐跳检查确切主机、协议和端口，有跳数上限，全程不带 Cookie。落点为作品或直播间时提示粘作者主页。 |
| 输入精确抖音号，或按昵称找人 | `www.iesdouyin.com/web/api/v2/user/info/` 收 `unique_id`，成功时读 `user_info.sec_uid`。Amagi 在这个接口关闭签名并移除 Cookie。昵称使用独立的 `www.douyin.com/aweme/v1/web/discover/search/` 用户搜索。[精确查号](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/platforms/douyin/endpoints/guestUserInfo.ts#L10-L37) · [用户搜索](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/platforms/douyin/api.ts#L382-L403) | 查号须核对返回的账号。昵称搜索按 `sec_uid` 去重，返回最多 10 个候选。同名时展示可区分的账号信息，由用户选择。遇拦截提示可改贴作者主页。 |
| 刷新作者资料 | `www.douyin.com/aweme/v1/web/user/profile/other/` 收 `sec_user_id`，读取 `user.sec_uid`、昵称、头像、粉丝数和 `live_status`。[资料请求](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/platforms/douyin/api.ts#L354-L370) · [字段样本](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/response-types/src/generated/douyin/UserProfile/UserProfile_V0.ts#L72-L135) | 同轮复用同一作者的资料请求。核对身份才交 `reportProfile`，粉丝数缺失时沿用已有资料，不能写成零。 |
| 检查视频与图文 | `www.douyin.com/aweme/v1/web/aweme/post/` 收 `sec_user_id`、`max_cursor`、`count`。看 `aweme_list`、`has_more` 与下一页游标。Amagi 明示中途失败可返回部分结果。[列表参数](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/platforms/douyin/api.ts#L307-L322) · [翻页语义](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/platforms/douyin/endpoints/userVideoList.ts#L29-L46) | `aweme_id` 字符串作 `postId`，`create_time` 的秒转成带时区的 ISO 时间。图文从 `images` 取图，视频取封面和详情链接，图片经 `ctx.fetchImage` 入图库后交 `reportPost`。[作品类型分支](https://github.com/ikenxuan/karin-plugin-kkk/blob/e97c1c8b6da19d6e8159f2314ab2c87e888c265e/packages/core/src/platform/douyin/workType.ts#L120-L146) |
| 核对直播 | kkk 在资料的 `live_status === 1` 时从 `room_data` 取 `owner.web_rid`，结合 `room_id_str` 查 `live.douyin.com/webcast/room/web/enter/`。[直播分支](https://github.com/ikenxuan/karin-plugin-kkk/blob/e97c1c8b6da19d6e8159f2314ab2c87e888c265e/packages/core/src/platform/douyin/push/live.ts#L24-L83) · [直播请求](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/platforms/douyin/api.ts#L485-L511) | `web_rid` 用于房间链接，`room_id_str` 标识上游这场直播，均按字符串处理。查到明确状态才上报。开播时间有可靠来源才填，资料缺字段、网络失败或验证页都保留上一场状态。 |

## 风控如何处理

Amagi 先读验证响应头，再辨认验证页面、验证指令和业务错误。作品请求使用与实际浏览器标识和最终查询参数相符的签名、作者主页 Referer 和会话信息。它对能识别的两类网页网关挑战（WAF、VMP）有自动处理分支，滑块需要真人处理。[响应判定](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/platforms/douyin/judge.ts#L232-L293) · [签名输入](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/platforms/douyin/sign/steps.ts#L30-L46) · [网关挑战的处理分支](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/platforms/douyin/anticrawler/solver.ts#L83-L104)

kkk 在有消息上下文时可把验证二维码私发给账号持有人，同一验证只发一次，探测通过后重做原请求。后台定时任务没有消息上下文，直接退出这个交互分支。默认推送任务每 10 分钟运行，每位作者的各推送类型之间等待 1 秒，作品取 15 条。这些是 kkk 的调度选择，本次未查到对应网页接口的官方配额。[人工验证](https://github.com/ikenxuan/karin-plugin-kkk/blob/e97c1c8b6da19d6e8159f2314ab2c87e888c265e/packages/core/src/module/utils/RiskVerify/index.ts#L174-L205) · [原请求重做](https://github.com/ikenxuan/karin-plugin-kkk/blob/e97c1c8b6da19d6e8159f2314ab2c87e888c265e/packages/core/src/module/utils/amagiClient.ts#L138-L162) · [推送周期](https://github.com/ikenxuan/karin-plugin-kkk/blob/e97c1c8b6da19d6e8159f2314ab2c87e888c265e/packages/core/config/default_config/douyin.yaml#L82-L90) · [轮询与取数](https://github.com/ikenxuan/karin-plugin-kkk/blob/e97c1c8b6da19d6e8159f2314ab2c87e888c265e/packages/core/src/platform/douyin/push.ts#L813-L857)

**本机观测。** 用明确标识调研用途的客户端对公开抖音号 `rmrbxmt` 做了一次匿名 GET，只访问上述抖音号查询接口。响应是 HTTP 200、`application/json`、正文 0 字节，含验证相关响应头。仅记录了该类头是否存在，未判断其值代表哪种验证。没有作者 ID 可继续查，因此作品与直播没有发请求。这个样本能复现“请求成功到达却没有作者数据”，还不能说明带凭据的可用率或平台频率上限。

| BN 收到的证据 | 首版处理建议 |
| --- | --- |
| 尚未登录，或上游明确表示已有登录已失效 | 来源交出对应登录状态，宿主沿账号问题提示去「系统 → 账号」扫码。验证失败与登录失效各自判定。短链、访客查号、日志和错误文本均不携带凭据。 |
| 有效验证头、明确的验证指令或人机验证页 | 暂停受影响的请求，用同一个持续问题提示账号持有人在抖音官方页面完成验证。恢复后只试一个请求，成功才恢复该类轮询。 |
| HTTP 429 | 同一会话下的轮询和手动刷新共用冷却；服务端给了 `Retry-After` 就遵守，届时先放行一个请求。 |
| 超时、5xx、空正文、字段结构异常 | 报暂时不可用，保留已知数据，退避后再查。单凭空包不能判定 Cookie 失效。403 明确点名签名失配时提示拓展需要适配，避免反复要求用户重新登录。 |
| 明确的私密、不可见或作者已不存在 | 问题只记在对应作者，其他订阅继续。只由同一作者或同类会话请求的成功结果清除对应问题。 |

Amagi 的完整客户端自行创建 HTTP 客户端，包声明 GPL-3.0-only。首版建议独立在拓展内处理接口与返回值，通过 BN 的 `ctx.http` 发请求、通过宿主取图和收尾。[Amagi 客户端](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/client/runtime.ts#L180-L214) · [包声明](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/package.json#L13-L17) · [BN 集成副作用约定](../agents/conventions/integration-side-effects.md)

6-08 应先验证用扫码取得的会话读取资料和作品。BN 默认请求会用本域已有的 Cookie 覆盖请求头里的 Cookie。签名输入必须与实际上线的浏览器标识、URL 和会话一致。6-07a 应核对会话隔离办法；若用 `bare` 显式传凭据，只向固定 API 主机发送，禁止携带凭据跳转。验收覆盖换号后的旧请求、旧 Cookie 和匿名短链。此次匿名样本未验证登录后的请求链。[BN 请求选项](../../packages/internal/src/http.ts) · [逐跳构造请求头](../../packages/http/src/http-client.ts)

## BN 的判新与直播语义

- **作品。** kkk 按最近 24 小时和各群的发送记录筛选。BN 在启动或新增作者后的首次完整查询只记基线，之后按作者、发布时间及同秒的作品 ID 判新，按旧到新上报。置顶改变排序时要检查后面的新作。同秒两条不同作品各报一次，跨页重复只报一次。翻页须有上限，游标重复或中途受阻保留旧基线，下一轮从最近页重查。目标选择、投递和去重沿用 BN 链路。[kkk 作品筛选](https://github.com/ikenxuan/karin-plugin-kkk/blob/e97c1c8b6da19d6e8159f2314ab2c87e888c265e/packages/core/src/platform/douyin/push/post.ts#L27-L55) · [BN 订阅源定案](../adr/0019-subscription-source-opening.md)
- **直播。** kkk 的首个资料检查中，先前在播且本次 `live_status` 不等于 1 就会更新为关播，字段缺失也能进入这个分支。BN 首次观测交 `status`，之后只在确认变化时交 `start` 或 `end`。周期「直播」由宿主调 `fetchLiveStatus` 核验，失败返回 `ok: false`。这样暂时读不到资料不会制造一张下播卡，重复样本和重启补报沿宿主的场次与开关处理。[kkk 关播分支](https://github.com/ikenxuan/karin-plugin-kkk/blob/e97c1c8b6da19d6e8159f2314ab2c87e888c265e/packages/core/src/platform/douyin/push/live.ts#L74-L85) · [BN 来源契约](../../packages/internal/src/extension/index.ts) · [宿主直播推送](../../apps/server/src/live/live-push.ts)

## 与 B 站对齐到哪里

| 用户在 BN 里做的事 | 对齐方案与差异 |
| --- | --- |
| 添加订阅、查看资料、接收作品和三种直播通知 | 使用同一页、同一套通知开关、卡片皮肤、推送目标、历史和统计。B 站支持 UID、主页与昵称。抖音可用主页、精确抖音号、昵称候选。同样显示开播／直播／下播，但抖音首版的发现时效取决于轮询、冷却和上游可用性。[B 站搜人](../../apps/server/src/bilibili/search-creators.ts) · [直播场次](../../apps/server/src/live/live-sessions.ts) |
| 在群里贴作品链接 | B 站已支持视频直链与短链。抖音首版也收视频、图文及它们的分享短链，即使没有订阅作者也能使用。启用现有链接解析后，由宿主管每群开关、回复形式、额度和冷却，默认关闭。抖音取作品详情、交回作品和规范 `aweme_id`，同一作品的长短链共享冷却。失败时群内静默。图片卡和文字沿用现有回复；群选原生分享、又没有已验证的抖音原生描述时，按现有规则回图片卡。[群聊行为](../agents/commands.md) · [回复与回落](../../apps/server/src/link-preview/link-previewer.ts) · [抖音作品详情](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/platforms/douyin/api.ts#L167-L177) |
| 扫码登录、查看账号、退出与重新登录 | 6-07a 让抖音复用「系统 → 账号」的账号行与扫码界面，正常使用无需手动粘贴 Cookie。两个来源可以同时登录，单独换号或退出。二维码过期是本次扫码失败，已登录凭据被上游明确拒绝才算登录失效。[宿主账号状态](../../packages/internal/src/auth-state.ts) · [来源账号页](../../apps/web/src/components/accounts/source-account-row.tsx) |
| 卡片编辑器预览、直播互动 | B 站还提供真实作者素材预览和弹幕等直播互动。抖音首版的卡片编辑器沿用拓展示例，礼物、粉丝团等互动留到以后。[现有拓展边界](extension-contract.md) · [订阅源定案](../adr/0019-subscription-source-opening.md) |

## 扫码与二次验证

kkk 登录实际调用 Amagi 的 Passport 会话。先从 `login.douyin.com/passport/web/get_qrcode/` 取得二维码和时限，再通过 `/passport/web/check_qrconnect/` 查询待扫、已扫待确认、成功、需验证或过期等结果。成功路径处理官方 SSO 跳转并取得登录态。这个流程与轮询作品时遇到的人机验证是两件事。[扫码与轮询](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/platforms/douyin/session/qrcode.ts#L67-L175) · [Passport 与跳转](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/platforms/douyin/passport/client.ts#L144-L234)

遇到短信验证时，Amagi 把发码与验码绑在同一登录会话；kkk 收到图形验证会结束这次登录。BN 现有 `SourceAuth` 能发起扫码、退出和读状态，但没有交回验证码的操作。6-07a 复用原扫码弹窗，补上受面板鉴权保护的二次验证交互。二维码、短信码和验证票据只在当前会话内流转；只允许账号持有人在官方提供的页面完成图形验证，有效会话经上游确认后才保存登录。上游不给可用验证途径时说明原因，可重新扫码。[kkk 二次验证](https://github.com/ikenxuan/karin-plugin-kkk/blob/e97c1c8b6da19d6e8159f2314ab2c87e888c265e/packages/core/src/platform/douyin/login.ts#L177-L219) · [短信应答](https://github.com/ikenxuan/amagi/blob/094238d5d5f8c20abba5c3e5c7d03741190e2ab1/packages/core/src/platforms/douyin/session/qrcode.ts#L197-L239) · [BN 的来源账号接口](../../packages/internal/src/source.ts)

## 已确认的首版与验收

6-07 给拓展开放群聊作品 `linkResolver`，6-07a 独立接入系统账号扫码和二次验证。订阅页识别作者主页已有 `searchCreators`。群聊解析则由拓展在清单声明可认的网址，宿主只将命中的单条链接交给它，停用即撤。已有通用 AI 工具可读 BN 记录的作者资料、作品与在播状态。[首版定案](../adr/0047-douyin-source-parity.md) · [现有 AI 工具](../../packages/ai/src/tools.ts) · [第六期片表](phase-6-plan.md)

| 验收入口 | 可观察的结果 |
| --- | --- |
| 6-07。通过宿主装载拓展，沿现有群消息入口输入链接并观察回复 | 只有声明并启用的解析器可接收匹配链接；停用撤销。视频与图文直链、分享短链、越界跳转、未订阅作者、同一作品长短链重复、逐群关闭、风控静默、图片／文字及原生分享回落。既有 B 站解析器与抖音可同时使用。 |
| 6-07a。沿来源登录、账号路由、系统账号行与扫码弹窗入口操作，抖音响应使用脱敏样本 | 出码、待确认、二次验证成功与失败、扫码过期、重新扫码、退出、重启恢复、凭据失效；多个来源同时登录或一方换号时，旧请求不能恢复已结束的会话。账号凭据进宿主机密存储，短信码不落盘。 |
| 6-08。激活实际拓展，通过公开来源入口搜人、刷新、启动轮询；宿主 HTTP 返回去除凭据的样本 | 精确抖音号与主页归一，昵称候选可区分同名作者，短链越界在请求前拒绝。未登录、合法空列表、200 空包、需人工验证、签名失配、限流、私密作者各有可区分的结果。覆盖首次基线、置顶、图文与视频、同秒双作品、跨页失败后恢复、停止时取消在途请求。 |
| 6-09。同一公开来源入口上报状态，沿既有宿主场次入口核对 | 已在播时启动、开播、周期核验、明确下播、重复状态，以及在播中被拦截后恢复。核对推送次数、原场次和停用后无上报。 |
| 6-10。沿现有宿主链路验收，并单列真实上游结果 | 合成样本验证资料、卡片、目标、历史与统计能贯通。真实验收由账号持有人在面板扫码，分别记录登录、昵称搜索、资料、视频、图文、群聊解析、在播／离线和图片读取。只有实际触发的二次验证、开播与下播才记作真实观察。 |
