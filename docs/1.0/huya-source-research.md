# 虎牙直播订阅源调研与设计草案

2026-11-23 核对。建议以虎牙网页使用的房间资料接口支撑匿名订阅，首版提供开播、正在直播和下播通知。日常只查询正在监听的房间。虎牙已将旧开放 API 的主播资料与订阅事件接口标为下线，仍有文档的 `hyExt.context.getLiveInfo()` 需要虎牙小程序的当前房间上下文。本次查到的网页接口缺少面向第三方的可用性和配额承诺。[开放 API 清单](https://dev.huya.com/docs/miniapp/dev/open/list/) · [小程序当前房间接口](https://dev.huya.com/docs/miniapp/dev/sdk/hy-ext-context-get-live-info/)

## 值得参考的实现

| 项目 | 源码里值得看的部分 | 对虎牙拓展的用途 |
| --- | --- | --- |
| renmu123/biliLive-tools | 移动端适配器用 `profileRoom` 取房间资料，从 `liveStatus`、`introduction`、`screenshot` 和秒级 `startTime` 组装结果。它还要求有可录制的流。 | 参考房间字段和在播样本。BN 可以在收到状态后直接判播，省去播放器和 CDN 请求。[资料请求](https://github.com/renmu123/biliLive-tools/blob/924bd077afe9473488033e93b7137cd821640fcf/packages/HuYaRecorder/src/huya_mobile_api.ts#L11-L31) · [字段映射](https://github.com/renmu123/biliLive-tools/blob/924bd077afe9473488033e93b7137cd821640fcf/packages/HuYaRecorder/src/huya_mobile_api.ts#L83-L102) |
| washls/douyin-live-monitor | 虎牙适配器读取 `realLiveStatus`，只认 `ON` 和 `OFF`。调度器串行检查同平台房间，共享限流冷却，将连续未知结果退避。 | 借鉴请求调度和失败分类。虎牙实测还会返回 `REPLAY`，需要单独识别。[虎牙适配器](https://github.com/washls/douyin-live-monitor/blob/9e759ad474e52ed3eed1afe67efa01366ef95704/douyin_monitor/platform_clients.py#L393-L435) · [HTTP 错误分类](https://github.com/washls/douyin-live-monitor/blob/9e759ad474e52ed3eed1afe67efa01366ef95704/douyin_monitor/platform_clients.py#L265-L310) · [调度](https://github.com/washls/douyin-live-monitor/blob/9e759ad474e52ed3eed1afe67efa01366ef95704/douyin_monitor/monitor_service.py#L726-L749) · [冷却与退避](https://github.com/washls/douyin-live-monitor/blob/9e759ad474e52ed3eed1afe67efa01366ef95704/douyin_monitor/monitor_service.py#L852-L901) |
| xiaoyaocz/dart_simple_live | 主播搜索读 `search.cdn.huya.com` 的 `getSearchContent`，取 `response["1"].docs`。房间搜索另外读分组 `"3"`。 | 按昵称添加时取主播候选，日常轮询直接查已选主播的房间。[主播搜索](https://github.com/xiaoyaocz/dart_simple_live/blob/ba828e6783b176ea5709fcd09f0eb01dfaceeb51/simple_live_core/lib/src/huya_site.dart#L493-L522) |
| daochouwangu/kaibola | 浏览器插件先用 `checkLogin.php` 取当前登录用户，再从 `subscribeList` 读取该账号的关注列表。 | 适合研究将来的“导入我的关注”。这条路要求虎牙登录态，覆盖范围取决于账号关注了谁。[关注列表实现](https://github.com/daochouwangu/kaibola/blob/1c50c1024050d961504b5829c242554c0b2d5313/src/fetcher/huya.ts#L4-L31) |

## 匿名接口实测

房间资料请求为 `GET https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=<数字房间号>`。以下是当日少量、无 Cookie 的单次 HTTP 读取。三个样本都返回 HTTP 200，响应头标为 `text/html`，正文实际是 JSON。读取时先检查 HTTP 状态，再解析有限大小的正文、检查业务 `status` 和预期字段。仅按响应头拒绝 HTML 会丢掉正常结果。

| 输入 | 当时的响应 | 设计依据 |
| --- | --- | --- |
| 房间 `660000` | `liveStatus / realLiveStatus = ON / ON`，主播 UID `1346609715`。有标题、分区、封面和开播时间。 | 一个房间资料请求同时取得身份和直播状态。[房间资料](https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=660000) |
| 房间 `518512` | `OFF / OFF`，仍有 `startTime`。UID 和房间号均为 JSON 字符串，在播样本中两者是数字。 | 以状态判播，身份统一读为十进制字符串，数字超出 JS 安全整数范围时需保留原文。[房间资料](https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=518512) |
| 房间 `660527` | `REPLAY / REPLAY`，仍有封面、开播时间和场次 ID。 | 回放可播放，主播当前按未开播处理。[房间资料](https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=660527) |
| 房间别名 `lpl` | 手机页跳转到主站，主站房间页的 canonical 指向 `/660000`。把 `lpl` 或主播 UID `1346609715` 直接填入资料接口的 `roomid` 都得到 HTTP 200、业务码 422 和空数组。 | 粘贴别名链接时先从该房间页取规范数字房间号，再查资料。单凭 422 无法判定这个人不存在。[别名房间页](https://www.huya.com/lpl) |
| 主播 UID 主页 | 在播 UID `1346609715` 的主页含指向 `/660000` 的“直播间”链接，离线 UID `1860982765` 的主页也指向 `/518512`。 | 本地房间号缓存丢失或过期时可从 UID 找回入口，再由房间资料核对主播。[在播样本主页](https://www.huya.com/video/u/1346609715) · [离线样本主页](https://www.huya.com/video/u/1860982765) |
| 昵称“虎牙英雄联盟赛事” | 主播搜索返回两个候选，首项同时有 `uid = 1346609715`、`room_id = 660000` 和昵称。用同一 UID 作搜索词则返回零个候选。 | 昵称搜索交给用户选择，同名候选按 UID 区分。按 UID 恢复走主页。[主播搜索样本](https://search.cdn.huya.com/?m=Search&do=getSearchContent&uid=0&v=1&typ=-5&livestate=0&rows=3&start=0&q=%E8%99%8E%E7%89%99%E8%8B%B1%E9%9B%84%E8%81%94%E7%9B%9F%E8%B5%9B%E4%BA%8B) |

## BN 怎样订阅和判播

**身份与资料。** 在 `extensions/huya/` 通过公开 SDK 的 `ctx.registerSource` 登记 `SourceDef`。身份用 `{ sourceKey: "huya", externalId: "<profileInfo.uid>" }`，可见房间号用 `displayId = String(profileInfo.profileRoom)`。展示房间号使用 API 1 修订 2 引入的字段，直播热度和贵宾人数使本拓展的最低宿主修订升至 5。虎牙允许房间号与自定义地址并存，也曾通过活动更换房间号。以 UID 认人，同一主播从昵称、房间号或别名链接添加都会落到同一身份。[虎牙房间号说明](https://blog.huya.com/product/187) · [SDK 作者指南](../../packages/extension/DEVELOPMENT.md#先做一个订阅来源)

`searchCreators` 声明接受 `id`、`link`、`name`，数字输入按房间号解读，昵称返回至多十个去重候选。别名只解析已知虎牙房间页的 canonical，跟随跳转时逐跳核对 HTTPS 和主机。日常按 UID 查近期房间号，`fetchProfile` 与状态请求复用同一份房间资料。缓存缺失、旧房间消失或 UID 不符时，从该 UID 主页的直播间链接重新定位一次。仅在新响应的 `profileInfo.uid` 与订阅相符时接受资料和状态。仍找不到本人时保留原订阅并报告定位问题。[SDK 订阅源入口](../../packages/extension/AGENT_GUIDE.md) · [BN 订阅身份](../agents/subscriptions.md)

**直播信号。** 清单声明 `liveStart`、`liveStreaming`、`liveEnd`，实现 `fetchLiveStatus`。轮询只处理 `subscriptions()` 中 `monitorsLive` 为真的主播，随 `onSubscriptionsChanged` 更新。推送式轮询与宿主拉取共用以下判定。[SDK 作者指南](../../packages/extension/DEVELOPMENT.md) · [抖音拓展已有的直播信号处理](../../extensions/douyin/src/live.ts)

| 房间资料 | 拓展如何处理 |
| --- | --- |
| 两个状态字段均为 `ON` | 确认为在播。标题取 `liveData.introduction`，分区取 `gameFullName`，封面取 `screenshot`，房间链接使用核过的数字房间号。有效的秒级 `startTime` 转为带时区的 ISO 时间。 |
| 两者均为 `OFF`，或两者均为 `REPLAY` | 确认为未开播。刚从在播变为轮播时结束上一场。轮播与离线互换时没有新的场次事件。 |
| 字段缺失、未知、互相冲突，或房间受限而无法确认状态 | 轮询保留最后一次确认的观测。拉取返回 SDK 失败结果，交由宿主跳过该轮。恢复后的第一份有效观测再与上次确认值比较。 |

首次有效观测只用 `reportLive` 报 `status` 建立基线。随后确认开播报 `start`、确认下播报 `end`，同一场重复观测只更新资料。跨过两轮之间的短暂下播时，只有前后均有可信且不同的场次标识才结束旧场、开启新场。缺少可靠的下播时间可省略 `endedAt`，由宿主取发现时刻。断流宽限、启动补报、周期卡、路由和历史由宿主处理。头像、封面经 `ctx.fetchImage` 换成图库引用，图片失败仍交付有效状态。[BN 直播契约](./subscription-sources.md#直播) · [SDK 副作用约定](../agents/conventions/integration-side-effects.md)

直播间展示的「直播热度」来自房间资料的 `liveData.totalCount`。贵宾标签取自网页的匿名汇总接口 `liveui.getVipBarListStat`，按主播 UID 读取响应的 `iTotal`。在播基线、新场次和宿主取直播卡时查询贵宾人数，同一场的常规轮询直接复用房间请求。汇总失败时卡片仍展示其他已获取的资料，平台明确返回的零照常展示。[飞机文直播间](https://www.huya.com/155525) · [虎牙贵宾榜组件](https://a.msstatic.com/huya/main3/components_RoomRank_index_tsx_5ca0c9c1.js)

## 请求节奏与风控

沿用宿主的 `ctx.http.fetch`、可回收定时器和 `AbortSignal`。建议起始值为同房每 60 秒检查一次，全虎牙同时一个请求、两次业务请求至少间隔 3 秒。多房间错开启动，房间数多时允许巡回时间自然拉长。搜索、主页定位、资料刷新和宿主周期拉取共用调度和冷却，同一房间的在途请求可合并。这些是 BN 的客户端参数，虎牙的实际限额未经测量。[参考项目的同平台调度](https://github.com/washls/douyin-live-monitor/blob/9e759ad474e52ed3eed1afe67efa01366ef95704/douyin_monitor/monitor_service.py#L726-L749)

| 情况 | 建议行为 |
| --- | --- |
| HTTP 429 | 全虎牙暂停新业务请求，返回 `rate_limited`。`Retry-After` 接受秒数或 HTTP 日期，等待至少到该时刻。缺失或无效时从 60 秒起退避。截止时间经 `ctx.state` 保存，重启后继续遵守。写入失败时维持内存冷却并报问题。[HTTP 语义](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3) · [仓内微博冷却实现](../../extensions/weibo/src/client.ts) |
| 401、403 或验证页 | 明确为单房间受限时只挂对应订阅的问题。普通拒绝访问且原因不明时返回 `unavailable` 并退避。遇到平台验证页或登录拦截时暂停全来源访问，在来源健康状态显示原因。冷却后允许一次正常匿名复查，成功再恢复调度。 |
| 超时、5xx、空响应、畸形 JSON 或字段变化 | 返回 `timeout` 或 `unavailable`，延后再查。错误经 `reportProblem` 汇总，成功后 `resolveProblem`。只有已确认的有效查询无匹配才给搜索返回空候选。 |
| 取消订阅或停用拓展 | 撤销对应计时、排队和在途工作，丢弃已失效订阅的迟到结果。 |

## 实施验收

首版实现与安装说明见[虎牙拓展](../../extensions/huya/README.md)。以下为 2026-11-23 的联调记录。

- 开发宿主挂载源码后，房间号 `660000`、手机别名链接 `lpl`、昵称“虎牙英雄联盟赛事”均可选到 UID `1346609715`。改装 ZIP 后，宿主按原有 UID 找回三个样本房间。BN 在播表列出了 `660000` 的标题、分区和开播时间。离线的 `518512` 和轮播的 `660527` 均未进入在播表。
- 在另一份空数据目录安装 ZIP，给房间接口提供 `OFF → ON → REPLAY` 的可控响应。首次离线保持静默，转入轮播后房间退出在播表。关闭开播时的「@全体」附加项，本地 webhook 收到一条开播和一条下播，主播与目标均和 BN 历史的两条 `delivered` 记录一致。公开房间在本次观测期间没有自然切换场次。
- [请求测试](../../extensions/huya/src/__tests__/requests.test.ts)覆盖跨房间限流、两种 `Retry-After`、无效期限回退、重启、验证页和恢复试探。[监听测试](../../extensions/huya/src/__tests__/monitor.test.ts)覆盖断续数据、场次识别和撤销订阅后的迟到响应。真实平台限流的触发阈值未经测量。
- 此次开发网络把虎牙图片域名解析到保留地址，宿主按图片访问规则跳过了实网头像和封面。用可控 PNG 验证了素材可以进入 BN 图库并回到主播候选中。
