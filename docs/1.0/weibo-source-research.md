# 微博订阅源的请求与会话设计

微博拓展通过 BN 的系统账号页扫码，从登录账号的关注流中挑出已订阅博主的新微博。订阅、路由、投递和历史沿用宿主。2026-11-22 核对了 Colter23 的 0.0.6 源码，参考的是网页请求、会话续期和失败处理。下面的端点是该版本所用的微博网页接口，其可用性随微博网页变化。[参考版本 e7335bc](https://github.com/Colter23/dynamic-bot-weibo/tree/e7335bca8e3f121d90c4f669e4e2a3c3cf4d9b9a) · [BN 订阅源契约](../agents/subscriptions.md)

## 登录怎样保持

扫码有两次确认。手机先通过微博的登录请求，拓展再沿登录服务给出的 HTTPS 跳转取得各域 Cookie，并从微博 PC 首页的 `window.$CONFIG.user` 核对账号。新浪长期凭据（通常为 `ALC`）和微博网页会话（`SUB`）属于不同域。BN 使用 `ctx.createCookieSession` 处理每一跳，只将已核实账号的 UID、会话快照和续期信息写入 `ctx.secrets`。[上游扫码和续期](https://github.com/Colter23/dynamic-bot-weibo/blob/e7335bca8e3f121d90c4f669e4e2a3c3cf4d9b9a/src/main/kotlin/top/colter/dynamic/weibo/WeiboClient.kt#L76-L242) · [BN 账号实现](../../extensions/weibo/src/account.ts)

| 时机 | BN 的处理 |
| --- | --- |
| 启动时有已存会话 | 重新核对原 UID 后开放取数。正常运行中每 6 小时核查一次，距上次成功续期满 24 小时且有长期凭据时，尝试新浪 SSO 续期。 |
| 普通接口明确要求登录 | 账号的读取请求串行。当前请求进入共用的核查／续期流程，成功后最多重读一次。账户页刷新直接读取内存状态。 |
| 拿到新票据 | 在独立的 Cookie 会话中跟随受支持的跳转，核对新签发的 `SUB` 确实适用于微博首页，并比对 UID。存储成功后才替换当前会话。换号、退出和停用会中止旧请求。 |
| 原会话仍有效，主动续期需要人工处理 | 继续使用刚核实的会话，保留原凭据，显示续期提示。重新扫码可建立新的长期会话。缺少长期凭据时也可使用尚有效的网页会话。 |
| 临时网络故障或服务端故障 | 保留原凭据。登录核查按 5 分钟、30 分钟、6 小时退避。业务取数下次检查时再试。 |
| HTTP 429 | 遵守 `Retry-After` 的秒数或日期，缺失时等待 60 秒。冷却截止时间写入 `ctx.state`，约束扫码、账号检查、资料和关注流请求。 |
| 403、验证页或账号变化 | 普通 403 返回暂不可用。明确遇到验证页时暂停自动请求，提示使用者在微博处理。发现续期 UID 变化时放弃候选会话。 |

上游也将“平台暂时读不到”和“长期凭据需要使用者处理”分开，并合并并发续期。其普通 API 错误处理把部分 403 计入未登录。BN 保留单独的验证和限流状态。上述时间是客户端策略。长时间保持登录仍取决于账号、平台凭据和实际运行环境。[上游会话协调](https://github.com/Colter23/dynamic-bot-weibo/blob/e7335bca8e3f121d90c4f669e4e2a3c3cf4d9b9a/src/main/kotlin/top/colter/dynamic/weibo/WeiboSessionCoordinator.kt#L61-L115) · [上游响应分类](https://github.com/Colter23/dynamic-bot-weibo/blob/e7335bca8e3f121d90c4f669e4e2a3c3cf4d9b9a/src/main/kotlin/top/colter/dynamic/weibo/WeiboClient.kt#L1028-L1075)

## 请求与 BN 入口

| 操作 | 平台接口 | 宿主可见的结果 |
| --- | --- | --- |
| 获取二维码、等待确认 | `passport.weibo.com/sso/v2/qrcode/image`、`/sso/v2/qrcode/check`，成功后进入 `/sso/v2/login` | `SourceAuth` 提供二维码、等待确认、已登录与需要处理的状态。二维码图片只从预期的微博图片服务读取。 |
| 检查账号、续期 | `weibo.com/`、`login.sina.com.cn/sso/login.php` 及其受支持的 SSO 跳转 | 核实同一账号，按域接收服务端更新的 Cookie。 |
| 昵称、UID 或主页查博主 | `weibo.com/ajax/profile/info`，以 `screen_name` 查完整昵称，或用 `uid` 查数字 UID，均带 `scene=1` | `searchCreators` 使用返回的 UID 标识候选，`fetchProfile` 按 UID 获取名字及可用的头像、简介、粉丝数。明确未关注时提示先在微博关注。 |
| 检查新微博 | `weibo.com/ajax/feed/friendstimeline`，`list_id` 和 `fid` 使用当前账号的“最新微博”流，`since_id` 分页，每页请求 25 条 | `subscriptions()` 给出启用名单，所有博主共享取数，只对开启作品通知的匹配者调用 `reportPost`。 |
| 补全长文 | `weibo.com/ajax/statuses/longtext`，参数 `id` | 只为准备上报的长微博取正文。HTML 转为文本，图片经 `ctx.fetchImage` 取得图库引用。 |

选择关注流意味着订阅前要由使用者在微博关注博主。增加或删除 BN 订阅只改变 BN 里的名单。创作者身份取数字 UID 字符串，作品取数字 ID。链接优先使用微博返回的 `mblogid`。拓展将话题与超话转为正文片段。卡片从关注流的 `source` 和 `region_name` 读取发布设备和公开发布地。超话归属取自 `title_source` 或作者旁的超话标记，匹配 `common_struct` 的名称、图库封面、说明与关注文字组成附卡。转发原文按署名文本呈现，因此宿主的原生转发过滤无法识别这种展示。[上游关注流解析](https://github.com/Colter23/dynamic-bot-weibo/blob/e7335bca8e3f121d90c4f669e4e2a3c3cf4d9b9a/src/main/kotlin/top/colter/dynamic/weibo/WeiboClient.kt#L554-L631) · [拓展作品类型](../../packages/internal/src/extension/index.ts)

## 分页与判新

业务 API 的相邻请求至少间隔 1 秒。首次成功检查记下最新发布时间及该秒已见的作品 ID。后续遇到更新的时间或同秒的新 ID 时，暂存匹配的作品，从旧到新上报。置顶作品跳过。每轮最多读三页，尚未读到上次基线就保留分页位置，下轮继续。游标和 ID 即使以超大 JSON 整数返回，也按接口原文保留全部数字。分页失败或返回缺少身份、时间的作品时保留原基线。上报返回后逐条移出待报集合。单篇长文暂时读不到时保留到下轮补取，其余作品继续上报，下一轮照常读取关注流。`reportPost` 表示交给宿主，最终投递结果由 BN 记录。[关注流实现](../../extensions/weibo/src/feed.ts)

## 验证记录

2026-11-22，使用宿主的 ZIP 安装入口将 `weibo-0.1.0-alpha.1.zip` 装进临时目录，确认打包的入口能注册系统账号和订阅源，并读出四种语言。另以新的匿名会话调用打包后的 `SourceAuth.beginLogin`，使用 BN 的 HTTP 客户端访问微博。登录页、二维码签发和图片三次请求均返回 HTTP 200，账号入口进入 `awaiting-scan` 并提供 PNG。随即关闭这次尝试。

同日，在源码开发版挂载拓展后，用微博 App 扫码确认。以同一数据目录三次重启服务，每次都自动恢复了原账号。添加作品订阅并等首次读取关注流成功后，从已订阅的账号发布了一条新微博。本机通用 Webhook 收到了原帖链接，BN 推送历史也将同一链接记为已送达。再过一轮成功的关注流轮询，该帖仍只有一条推送历史和一份收件回执。自然到期后的续期和连续登录时长仍待实机观察。

本地回归从系统账号与订阅源入口注入上游响应，覆盖重启恢复、同 UID 续期、账号变化、并发请求、验证与冷却、分页重试、同秒判新和取消订阅。[账号回归](../../extensions/weibo/src/__tests__/auth.test.ts) · [请求回归](../../extensions/weibo/src/__tests__/source.test.ts) · [关注流回归](../../extensions/weibo/src/__tests__/feed.test.ts)
