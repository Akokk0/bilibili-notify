# ADR-0036：路由按资源整理 —— 顶层是资源，只属于它的才下沉

- **状态**：2026-10-03 `/grill-me` 拍板（一次一题，起因是主人问「路由会不会有点乱，`/api/maid-skills` 是不是该归到 `/api/ai` 底下」）。**决策 4 已施工**（10-03，第 2 期 ㉚，开 ⑭ 之前做）；决策 5 那几组随各自那一片。
- **记录方式**：拷问当场落的定案；逐条路径的新旧对照在本份「决策 4」，施工时照表搬。
- **影响面**：`apps/server` 各路由的挂载点、面板全部调用方、两道鉴权闸的放行前缀、文档里写着路径的地方。外面没人依赖这些路径：拓展与桥走 `/ext`，桌面壳只轮询 `/api/health`。
- **依赖**：[ADR-0012](0012-extensions.md) 决策 38（URL 面一律 `ext`）、[ADR-0023](0023-neutral-naming.md)（命名规矩）。

## 背景

今天 `/api` 底下 25 组，有几组其实是别的资源的附属：女仆技能只给 AI 聊天用却自成一组（`/api/maid-skills`），日志、更新、备份和重启、开新代都是这一个实例的事却分在四组，卡片皮肤和出卡分开，粉丝快照只喂统计却单独一组。路径里还有十几处带 `-` 的动作名（`test-push`、`render-source`、`run-now`……）。1.0 本来就要改几处（`/api/subs` → `/api/subscriptions`、`/api/push/test` → `/api/targets/:id/test` 等），但没有一条统一的判据，每加一个口都要现想放哪。

## 决策

1. **顶层是资源，只属于某个资源的东西才下沉成子路由。** 判据是「离开父资源它还有没有意义」：女仆技能离开 AI 聊天没有意义，下沉成 `/api/ai/skills`；素材库几家共用（卡片旋钮、直播封面，以后还有皮肤和拓展），留在顶层。仓里已有的几处子路由（`/api/subs/tags`、`/api/history/:id/repush`）是同一个判据。
   被否的备选：按大类分桶（`/api/push/*` 装历史、测试推送、目标，`/api/data/*` 装统计、粉丝、日志）—— 归哪一类常常说不清（历史算推送还是统计？），路径变长、信息不多，每加一个口都要先吵归类。
2. **路径里尽量不带 `-`，简单一点。** 动作按顺序套：能用 HTTP 方法表达的用方法（清掉用 `DELETE`），能当成一个东西的写名词，剩下的写成一个动词。拓展沿用 `ext`（ADR-0012 决策 38，不改成 `extensions`）。
3. **两样不动、一样不许放**：`/api/health`（桌面壳轮询、桌面令牌闸只放行它）与 `/api/session`（cookie 闸按这个前缀放行，登录口要免闸）不动；**要登录才给的东西不许放进 `/api/session` 底下**，那里免 cookie 闸 —— 面板 WS 的一次性票因此放 `/api/ws/ticket`，不放 `/api/session/ticket`。
4. **新旧对照**（照表搬，只改路径、不改行为）：

   | 今天 | 1.0 |
   | --- | --- |
   | `/api/globals` | `/api/settings`（施工计划里「到时问主人」的那一题，这次定了） |
   | `/api/subs`（含 `tags`、`:id/avatar`、`search`、`lookup`；`:id/avatar` 在 ⑳c 退役，头像走 `/api/images/<ref>`） | `/api/subscriptions`（1.0 原定；`search` / `lookup` 在 3a 再并进 `/api/sources/:sourceKey/creators`） | 🔗 现状（4-15，10-28）：`search` / `lookup` 与 `/api/ext/:id/lookup` 都删了，搜人只剩 `GET /api/sources/:sourceKey/creators?q=`。
   | `/api/fans` | `/api/stats/followers`（**推翻** 1.0 原定的 `/api/followers`：粉丝样本只喂统计与首页的统计卡） |
   | `/api/maid-skills` | `/api/ai/skills` |
   | `POST /api/ai/test-push` | `POST /api/ai/test` |
   | `/api/logs`、`/api/update`、`/api/backup` | `/api/system/logs`、`/api/system/update`、`/api/system/backup`（日志、更新、备份都是这一个实例的事；宿主传了才挂的更新、备份、系统三组并成一组，各个口原来挂不挂的条件照旧，日志仍是一直挂着） |
   | `/api/card-skins` | `/api/cards/skins`（`/:id/ai-css` → `/:id/ai`） |
   | `/api/skins` | `/api/dashboard/skins`（`/:id/ai-edit` → `/:id/ai`）；和卡片皮肤一个写法，「谁的」放前面，也对上盘上的 `skins/dashboard/` |
   | `POST /api/cards/test-push` | `POST /api/cards/test` |
   | `GET /api/cards/detect-chrome` | `GET /api/cards/chrome` |
   | `GET /api/cards/render-source`、`POST /api/cards/enable-rendering` | `GET` / `POST /api/cards/renderer` |
   | `POST /api/cards/skin-shot`（请求体带 `skinId`） | `POST /api/cards/skins/:id/screenshot` |
   | `POST /api/stats/roast/run-now`（及 `/:subscriptionId`） | `POST /api/stats/roast/run`（及 `/:subscriptionId`） |
   | `POST /api/dev/captures/purge-history` | `DELETE /api/dev/captures/history` |
   | `POST /api/auth/ws-ticket` | `POST /api/ws/ticket` |
   | `POST /api/push/test`（`targetId` 在请求体里） | `POST /api/targets/:id/test`（1.0 原定；`TestResponse` 与 `TestPushResponse` 合成一个是另一件事，不在这次） |
   | `POST /api/connections/:id/test` | `POST /api/connections/:id/probe`（1.0 原定） |

5. **随别的片一起搬的**（资源还没建，到时照决策 1、2 起名）：`/api/cards` 里背景图与字体那 8 个口 → `/api/library/images`、`/api/library/fonts`（与 `:id`，删前查引用）；`/api/qq/*` → `/api/adapters`（3a）；`/api/auth/*`（B 站登录）→ `/api/sources/:sourceKey/…`（3a）；问题表 `/api/problems`（3a）；图库的同源读口（⑮）与并进图库的三个读口（⑳：历史配图、订阅头像、聊天附件）。
    - 🔗 10-09（3a-20）：`/api/qq/*` 不单独搬地址，等对应的适配器成员落地时一起搬 —— 扫码绑定的两个口随 3a-29（`connectionAuth` 要 `AuthState`），选地址的两个口随 3a-22（`listAddressCandidates` 的形状和连接候选一起定）。仍在 3a 之内。
    - 🔗 10-11（3a-29）：`/api/qq/*` 已全部退役（选地址的两个口 3a-22 已搬到连接底下，扫码绑定的两个口随 3a-29 搬成三个）。新路径与方法：`POST /api/adapters/:adapterKey/auth`（发起，回任务号与此刻的状态）、`GET /api/adapters/:adapterKey/auth/:taskId`（读状态，不带草稿、不清草稿；读状态用 GET 且回包不带草稿，主人 10-11 定）、`POST /api/adapters/:adapterKey/auth/:taskId/draft`（取走草稿，取走即清，响应头 `Cache-Control: no-store`）。取草稿的路径段照决策 2「能当成一个东西的写名词」写成 `draft`（问主人时举的例子是 `claim`，但 `claim` 在登记表上已经是另一个意思）。`/api/adapters` 这个前缀由这三个口先建，各适配器描述的列表仍归第 4 期。
    - 🔗 10-11（3a-29 B 站半）：`/api/auth/*`（B 站登录）已全部退役。新路径与方法：`GET /api/sources/:sourceKey/auth`（读，回状态与账号）、`POST /api/sources/:sourceKey/auth`（发起扫码；状态是 `awaiting-scan` 时回 `conflict`，`confirming` 放行并换一张新码）、`DELETE /api/sources/:sourceKey/auth`（退出登录，清掉用 `DELETE`，决策 2）。旧的四个口里，读状态并进 `GET`，`POST /qr` 与 `POST /logout` 变成上面的 `POST` 与 `DELETE`，`POST /cookies/refresh`（手动刷新 Cookie）**直接删、没有后继**（主人 10-11 定：续期是 B 站自己的事）。`/api/sources` 这个前缀由这三个口先建；来源列表本身与 `/api/sources/:sourceKey/creators` 仍归第 4 期。`/api/ws/ticket`（原 `POST /api/auth/ws-ticket`）从此不再以登录系统在场为挂载条件，无条件挂在登录闸后面。

   🔗 **2026-10-03**（⑮ 开片拷问，主人拍板）：
   - 图库读口是 **`GET /api/images/<ref>`**：图库被历史、订阅、AI 共用，是顶层资源（历史配图的老读口 `GET /api/history/img/:name` 在 ⑳d 退役，面板的配图与头像快照都走这个口）。只读、只这一个口 —— 写入口留在各自业务里（聊天上传走 AI 那组、按它自己的上限查；抓图服务在服务端内部调），不开通用上传口，免得绕过各家的规矩。三道闸（nosniff、桌面令牌、登录 cookie）照旧，不开例外；按内容起名的东西永远不变，回 `Cache-Control: private, max-age=31536000, immutable`（`private`：它在登录闸后面）；mime 按扩展名给；引用不合规矩不碰盘、文件不在，都回 404。
   - **桌面令牌闸也认一个 cookie**：带对的令牌头进来时种一个 `HttpOnly; SameSite=Strict; Path=/api` 的 cookie，此后头与 cookie 认哪个都行（WS 照旧走 query）。起因：`<img>`、CSS `url()`、`@font-face` 带不了自定义头，桌面版里直连地址的图（历史配图、聊天附件、订阅头像、界面皮肤的壁纸与字体）都会 401；6 月只把卡片背景缩略图改成先取字节再转 blob 地址，其余几处漏了。门槛不变：cookie 只在桌面壳自己的 webview 里，脚本读不到、别的站带不上、换主机名的 DNS 重绑定也带不上，令牌每次启动都换。被否的备选：面板里所有图都先取字节转 blob（`<img>`、壁纸、字体各要接管道，新加的图每处都得记得绕，6 月那次就是这么漏的）；`/api/images` 免令牌闸（核心鉴权闸上开白名单，违背「改外围、不开例外」；引用会出现在历史与日志里，不是秘密）；令牌放进 query（会进地址栏、日志与浏览记录）。
6. **盘上布局与源码目录不跟着路径走**：API 按「谁的」分，盘上按「怎么存」分（两种皮肤合用一份存储、同一套备份与开新代规矩，所以盘上仍是 `skins/card/`、`skins/dashboard/`）。源码目录（`apps/server/src/card-skins/` 这类）在第 5 期「目录与文件名」清扫时跟着资源改；路由文件在这一片顺手改名。

## 后果

- 顶层从今天的 25 组并掉 9 组，加上 1.0 本来要新开的资源（来源、适配器、问题表、素材库、面板），共 20 组上下，每组都说得出是什么。
- 新加一个口先问「它离开哪个资源就没有意义」，有就挂在那个资源底下，没有就是新的顶层资源；名字一个词，不带 `-`。
- 面板缓存键里写死的老名字（如 `["globals"]`）随路径一起改；data-model 与 architecture 里写着 `/api/followers`、`/api/globals` 待议的地方随这一片改掉。

🔗现状（4-21，2026-10-30）：坏格读口按资源归属落在 `GET /api/settings/invalid` 与 `GET /api/ext/:id/settings/invalid`；备份纯路径预检为 `GET /api/system/backup/preview`。三个口均沿用既有会话 / 桌面令牌闸，设置 `Cache-Control: no-store`。既有设置回应形状不加保留顶层键，避免与登记集成键冲突。

🔗现状（4-23，2026-10-31）：素材库 8 口已从 `/api/cards` 搬至 `/api/library`：`GET` / `POST /images`、`GET` / `DELETE /images/:id`，字体对应 `/fonts` 与 `/fonts/:id`；旧口删除，无别名或重定向。两类文件仍沿用统一鉴权、私有永久缓存与删前引用检查，上传规矩、成功与失败形状、素材存储位置不变。现有两个 picker 与缩略图读取同步迁移；素材库顶层页与选择器合一仍归 4-50。真页面验收尚待可用浏览器，未记为切片完成。

🔗现状（4-23，2026-10-31）：统筹已补验真页面主要流程：图 / 字体上传与列举、图缩略图、双图序号、保存引用后拒删、解除并保存后删除，以及直播封面共用图库与口吻切换通过，前述待验状态已解除。字体文件 GET 的原字节、mime 与私有永久缓存由 CLI 回环请求补证，未作浏览器字体预览或卡片 PNG 渲染验收。390 宽仍有横溢出，既有 field-labels warning 如实记录；本轮 JS error 与服务端 level 50 / 60 均为 0。未逐项人为验证全部边界，自动门禁证据保持原交付。


🔗现状（4-50，2026-11-05）：面板顶层 `/library` 管理可反复选用的图片与字体，共用浏览组件用于原卡片字段的选择窗；读写仍走上述八口，图片维持鉴权对象地址。删除由管理页确认，冲突按标准码保留素材并显示原话；无新增引用计数或强删接口。当前验收与剩余范围以 [第4期片表](../1.0/phase-4-plan.md) 为准。
