# 抖音订阅源维护指南

面向 `extensions/douyin/` 的维护者，描述当前实现及其验证方式。安装和日常操作见 [README](README.md)，首版范围见 [ADR-0047](../../docs/adr/0047-douyin-source-parity.md)，真实平台证据见[验收记录](../../docs/1.0/douyin-source-acceptance.md)。

## 工程与宿主契约

- 官方拓展 ID 为 `douyin`，清单和包版本均为 `0.1.0-alpha.0`；要求 `apiVersion: 1`、`apiRevision: 2`。修订 2 提供抖音号等展示账号字段，稳定订阅身份仍为 `{ sourceKey, externalId }`，其中 `externalId` 是平台的 `sec_uid`。
- 本工程使用 workspace SDK；所有 BN 运行时能力只从 `@bilibili-notify/extension` 获取，构建配置使用其 `/build` 入口。源码不直接依赖宿主或 `internal`，请求、图片、凭据、计时器和问题报告均通过 `ctx`。
- `activate()` 注册一个带账号和链接解析能力的订阅源。没有拓展专用设置、指令或 AI 工具；没有实现 `fetchPreview`。作品和直播事件交给宿主，由宿主处理目标选择、发送、历史和统计。
- 官方拓展走主仓打包和市场流程，不需要 `.bn-extension/marketplace.json`。早期 `akokko.douyin` 是独立身份，代码收归不等于凭据或订阅迁移。

## 模块分工

| 文件 | 职责 |
| --- | --- |
| [src/index.ts](src/index.ts) | 装配账号、客户端、订阅源和作品链接解析器。 |
| [src/auth.ts](src/auth.ts) | 扫码尝试、验证、账号确认、会话恢复／续存、退出与账号切换。 |
| [src/passport.ts](src/passport.ts) | 首页访客协商、登录请求、SSO 跳转、账号确认及短信字段。 |
| [src/web.ts](src/web.ts) | 共用浏览器标识、签名和可信地址检查；不执行官网页面脚本。 |
| [src/client.ts](src/client.ts) | 数据请求、分端点参数策略、Cookie 续传、短链及退避。 |
| [src/creators.ts](src/creators.ts) | 主页／抖音号／昵称查找、候选去重、资料字段与展示抖音号。 |
| [src/source.ts](src/source.ts) | 订阅协调、逐博主轮询、资料及作品／直播上报、取消与收尾。 |
| [src/posts.ts](src/posts.ts) | 分页、作品基线、置顶／同秒判新以及视频／图文的卡片数据。 |
| [src/live.ts](src/live.ts) | 直播间核实、状态观测和场次变化。 |
| [src/links.ts](src/links.ts) | 分享链接展开、作品详情校验与卡片报告。 |
| [src/media.ts](src/media.ts) | 响应字段读取、候选图片 URL 与宿主图片库引用。 |
| `locales/{zh-CN,zh-TW,en,ja}.json` | 拓展的四语清单、提示和故障文案。 |

## 本机开发

使用仓库约定的 Node 与 vp，在**主仓根目录**执行：

```sh
vp install
vp run dev:apps
```

在开发版拓展页选择「挂载开发拓展」，指定 `extensions/douyin` 根目录并启用。宿主加载源码并监听保存，不需要先构建 `dist`，也不单独启动拓展进程。生产模式只加载安装包。

日常调试可以复用已保存的账号，但首次检查和热重载会重新建立内存基线。不要把重载后的“未补推旧作品”误判为推送故障。会向真实目标发送的检查需使用明确指定的测试目标；合成状态变化优先沿现有测试入口验证。

## 登录与会话生命周期

登录链路是「首页访客协商 → 二维码及轮询 → 手机确认 → 必要验证／SSO → 账号确认 → 保存会话」。手机确认只推进状态；账号接口核实前不将尝试标记为已登录。

每次扫码拥有独立 Cookie 会话和尝试标识。重扫、取消、超时、退出或拓展停用会使旧尝试失效；短信提交必须对应当前尝试。官网返回可用的外部验证地址时交给用户处理，不引入常驻网页或远程浏览器。真实短信和外部验证仍需区分合成覆盖与实机结果。

验证后的 Cookie 快照通过 `ctx.secrets` 的 `login.cookies` 保存。启动时恢复并向平台核实账号；暂时读取失败会重试，明确失效才清除当前凭据。头像单独异步下载，失败不会撤销已经核实的登录。

取数响应中的 Cookie／令牌变化也要续存；保存失败必须返回失败，不能假装续存成功。账号会话改变会中止旧请求，迟到的旧 401、分页结果、图片或头像不能清除新会话，也不能上报到新账号。排查时只记录阶段、错误码、状态和计数，不记录 Cookie、验证码或完整签名 URL。

## 当前上游请求

以下是代码使用的官网端点，用于定位实现；不是抖音承诺稳定的开放 API。登录端点集中在 `passport.ts`，普通取数集中在 `client.ts`。

| 操作 | 域名与路径 | 主要业务字段 |
| --- | --- | --- |
| 登录账号确认 | `www.douyin.com/passport/account/info/v2/` | 当前登录会话。 |
| 抖音号查询 | `www.iesdouyin.com/web/api/v2/user/info/` | `unique_id`。 |
| 博主资料 | `www.douyin.com/aweme/v1/web/user/profile/other/` | `sec_user_id`。 |
| 作品列表 | `www.douyin.com/aweme/v1/web/aweme/post/` | `sec_user_id`、`max_cursor`、`count=20`。 |
| 昵称搜索 | `www.douyin.com/aweme/v1/web/discover/search/` | `keyword`、`search_channel=aweme_user_web`、`count=10`。 |
| 直播间 | `live.douyin.com/webcast/room/web/enter/` | `web_rid`、`room_id_str`。 |
| 作品详情 | `www.douyin.com/aweme/v1/web/aweme/detail/` | `aweme_id`、`aid=6383`。 |

各端点的参数和签名策略不同：搜索保留其浏览器能力参数及每次请求的新令牌；作品详情在有访客标识时使用精简业务参数和官网 SDK 签名。不要仅为减少重复代码，把所有请求统一为同一套查询参数或签名。详情缺少 `aid`、附带额外环境参数，曾分别导致图文过滤和验证响应，历史对照见验收记录。

数据请求通过 `ctx.http.fetch`，限制自动跳转、超时和响应大小；Cookie 范围由宿主 Cookie 会话管理。短链只接受 HTTPS 及已列出的抖音域名，逐跳检查地址并限制次数。图片通过 `ctx.fetchImage` 转成宿主引用，不绕开宿主直接写文件。

### 失败分类与恢复

| 响应 | 当前处理 |
| --- | --- |
| HTTP 429 | 会话级退避，尊重 `Retry-After` 秒数或日期；缺失／无效时默认 60 秒，最少 1 秒。并发响应只延长当前冷却，不缩短。 |
| HTTP 403 且明确为签名／访客标识拒绝 | `douyin.signature`，该端点退避 10 分钟。 |
| 验证指令或验证码页面 | `douyin.verify`，该端点退避 5 分钟。 |
| 请求失败或超时 | 保留失败分类，该端点退避 15 秒。 |
| 空正文、非 JSON、未知过滤等不完整响应 | 暂时不可用，该端点退避 30 秒；不声称内容不存在。 |
| HTTP 401 或明确未登录 | 核对请求所用会话后使当前凭据失效，要求重新登录。 |
| HTTP 404 或明确私密账号 | 返回对应的未找到／私密说明；不把任意 `filter_reason` 都归为删除。 |

冷却后的下一次请求只允许一个恢复探测，其他调用不会同时冲上游。退避计时不是独立重试任务，轮询或用户请求到来才会探测。成功后按对应范围解除问题；换账号后旧响应不能恢复或覆盖新会话的问题状态。

## 轮询和事件语义

`source.ts` 以作者 ID 协调启用的订阅，启动即检查，此后每 10 分钟检查。单个来源的轮询逐博主执行，作品、直播和手动资料读取复用同一客户端；没有批量博主资料请求。订阅变化只将新增或开关变化的博主加入待查集合，未变化的订阅不会因此全部重查。

作品基线保存最高发布时间和同秒已见作品 ID；先完整解析所需分页，再更新基线。首次成功只建基线，后续按时间从旧到新上报；旧置顶不提前截断分页，同秒作品分别去重。每页请求 20 条，最多检查 20 页；循环或不前进的游标、缺页和不完整条目会使本次失败，保留旧基线。

首次直播观测只报状态，随后对开播／下播及场次切换生成变化。同场次未变化不重复产生开／下播；周期直播提醒由宿主策略安排。未知状态和请求失败不替换原观测。这里没有连接弹幕流，无法捕获所有轮询间隙内的短场次。

停用、卸载或来源销毁会取消计时器、监听和作者请求。基线在内存中，进程重启或来源重载会丢失；作品开关关闭后再开启也会建立新基线。停用期间不提供作品补推保证。

## 回归与安装包

以下命令均在主仓根目录执行：

```sh
vp run test extensions/douyin/src/__tests__ --reporter=dot
vp run -F @bilibili-notify/extension-douyin typecheck
vp run -F @bilibili-notify/extension-douyin build
vp exec node scripts/pack-extension.mjs --id douyin
```

四组来源回归分别覆盖账号、订阅、链接／客户端及注册装配。涉及宿主登录、来源注册或投递契约时，再运行已有安装包端到端入口：

```sh
vp run test apps/server/src/__tests__/douyin-source-e2e.test.ts --reporter=dot
```

提交前对改动的源码运行 `vp exec biome check <改动文件>`；阶段收尾沿主仓完整门禁执行 `vp run check`、`vp run build`、`vp run typecheck`、`vp run test --reporter=dot`。合成回归不访问真实平台，也不能代替扫码或自然事件的实机结论。

构建产物在 `extensions/douyin/dist/`，安装包默认为 `dist/douyin-<清单版本>.zip`。包内只收 `extension.json`、`index.mjs`，以及可选 `README.md`、`CHANGELOG.md` 和支持语言的 `locales/*.json`。本文不进入安装包，因此 README 对维护资料使用仓库网页链接。每份打包文档上限为 512 KiB。MIT 许可放在 `LICENSE`，第三方图形与依赖声明放在 `NOTICE`；构建时两者写入 `index.mjs` 的注释，随现有格式的安装包分发，README 不再承载许可正文。

安装包上传与开发挂载是两种加载方式。同 ID 已安装时先处理冲突，不能用开发挂载覆盖现有安装；不同 ID 的验证来源也不会自动合并身份和数据。

## 发行与证据

官方发行使用主仓的 [extension-release 工作流](../../.github/workflows/extension-release.yml)和[市场流程](../../docs/agents/extension-marketplace.md)：清单版本、更新记录与 `extension/douyin@<版本>` tag 对齐，tag 触发门禁、构建、ZIP 和索引发布。手动运行只在 `dev` 上以 `dry_run` 预检；本地构建不等于发行。SDK 契约有变化时，还需分别确认宿主及公开 SDK 的发行状态，不能仅看源码已更新。

[首版验收记录](../../docs/1.0/douyin-source-acceptance.md)保留了历史 API 1／修订 1 产物的证据；当前展示账号改进要求修订 2，旧产物通过不等于当前版本已完成发行。真实新增作品、短信二次验证和开／下播仍是已接受的后续观察项，不把模拟结果写成真实发生。

早期 API 取舍可参考[来源调研](../../docs/1.0/douyin-source-research.md)与[项目对照](../../docs/1.0/douyin-project-comparison.md)。排查新问题时以当前实现、实际响应和现有回归为准，保留这些历史记录的日期与局限。
