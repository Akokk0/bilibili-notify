# 第 3b 期计划表：各块中立化

3b 和 3a 一样单独一份计划表。总计划见 [construction-plan.md](./construction-plan.md)：那里只留 3b 的范围一行与指向这里的链接，**各片的进度、每组开工时定的事、留给后面的尾巴都记在这份文件里**。

## 状态

| 项 | 现状 |
| --- | --- |
| 切片表 | 10-13 排出，主人当天认了，同日开工；10-14 照 10-13 晚到 10-14 的定案重排：各片的题都答完了，新加 3b-51 至 3b-53；同日晚主人逐处过完没先问的八处缝，定下的改动新开 3b-54 至 3b-56；10-15 主人定开 3b-57（拆装配文件并改掉「引擎」旧叫法）、3b-58（外部 id 的格式由来源声明）；10-16 主人定开 3b-59（清单卡字体死链）、3b-60（撤 AI 对话痕迹的读时补标签）；10-20 主人定开 3b-61（换语言时问题表重报，从 3b-51 拆出）；10-24 主人定开 3b-63（B 站请求层给 wbi 一族加熔断） |
| 已完成 | 57 / 63（10-13 落 3b-01、3b-02、3b-03、3b-05、3b-06、3b-07、3b-13、3b-14、3b-15、3b-17、3b-19、3b-20、3b-27、3b-32；10-16 落 3b-28、3b-58、3b-04、3b-36、3b-54、3b-09、3b-37、3b-33、3b-40、3b-16、3b-53；10-17 落 3b-30、3b-60、3b-08、3b-38、3b-48、3b-29、3b-10、3b-56、3b-55、3b-41、3b-18、3b-52；10-19 落 3b-21、3b-59、3b-39、3b-43；10-20 落 3b-31、3b-11、3b-51、3b-61；10-21 落 3b-22、3b-23；10-23 落 3b-24、3b-34、3b-25；10-24 落 3b-35、3b-26、3b-62、3b-63、3b-12；10-25 落 3b-42、3b-44） |
| 13 行转对拍 | 13 / 13（N17 → P21、N07 → P22、N18 → P25、N12 → P27、N10 → P33、N04 / N11 → P34 / P35、N03 → P36、N02 → P39、N13 → P40、N06 → P41–P44、N16 → P45、N08 → P46（3b-12）。10-24 3b-26 对着对拍文件重数：这一格此前停在 5 / 13，N18、N12、N10、N04、N11、N06 各片落成时没跟着改） |
| 迁移修订号 / 备份版本 | 44 / 17（3b 开工前） |

## 出期条件

照 [construction-plan.md](./construction-plan.md) 分期表与「中立性守卫的归期」3b 那两格，字面不改：

- 六道棘轮清零：守卫 11、uid 棘轮、`.platform` 决定棘轮、推送守卫②、出网点名表、事件载荷。
- 新开且绿：守卫 21a（契约层对拍）、推送守卫③（假适配器对拍）、模板变量可满足性、AI 工具与技能约束。
- 守卫 21b「这版不开」名单里标 3b 的 13 行转成对拍，另补三项（按订阅的皮肤、点评输入与过滤用同一个取段函数、看图从图库引用）。
- 全量门禁全绿。

开片勘察按 10-12 的棘轮表估（没有逐处核）：六道里 3b 清得掉的约 263 处，文档已写明要等第 4 期的约 126 处，另有约 65 处当时没有任何一片认领，下面「原先没人认领的」逐件给了去处。清零期的字面与实际清得掉的时间不一致的那几格，照主人 10-12 定的，3b 收尾时再问。

## 切片表

10-12 开片：五份只读勘察（直播与资料、拓展契约与桥、链接预览与指令与 AI、守卫与出期条件、多语言地基与检测循环；报告在 `.bn-design/s3b-survey-*.md`，文档里归 3b 的条目清单在 `.bn-design/s3b-inventory.md`，都不入库）合成下面这张表。勘察是子代理的回报，**表里的规模是估的，各片开工时用到哪条核哪条**；每组开工前把那一组的未决项一题一题问完，定案先落 ADR。

规模：小 ≤ 5 个源文件；中 6–20；大 > 20，或牵涉线上格式与迁移。「盘」一栏写「是」的要抬迁移修订号与备份版本。

| 片 | 做什么 | 前置 | 盘 | 规模 |
| --- | --- | --- | --- | --- |
| **甲 随时能做的小片（互不相交）** | | | | |
| 3b-01 ✅ | 动态检测循环：不同创作者的抓图不再互相堵。落成（10-13）：一轮里过了闸的动态按创作者分组，组内照旧一条接一条、交出的先后不变，组与组之间并行、同时最多 4 条链；锚点仍在整轮跑完后一次回写，一轮仍要等最慢的那位跑完才算结束。直播封面那次抓图查过：每个直播间各有自己的串行闸，不会堵别的房间 | 无 | 否 | 小 |
| 3b-02 ✅ | 设置页的 AI 连通测试从路由挪进 `packages/ai`（出网点名表少一格）。落成（10-13）：`packages/ai/src/provider-probe.ts` 的 `probeAiProvider`，请求、失败码与文字逐字照搬；出网点名表里路由那一格清掉，新文件按「BN 自己的出口」进白名单 | 无 | 否 | 小 |
| 3b-03 ✅ | 删拓展契约第 1 版的退路（没有拓展还在走，纯删除）。落成（10-13）：宿主认的最低版本从 1 变 2，第 1 版清单判成「版本不合、换它的新版」、不再加载；`legacy-v1.ts`、`LegacyPushExtensionDef`、`ctx.publishStatus`、运行时交的外观与密钥键、详情页那块「老格式」提示都删了。密钥键从此只照清单读，没有清单可读的拓展不进表（它名下的连接设置与自己的设置整片当密钥遮）；这一处过了一次窄范围的独立审查，没有必须修的，补了一条钉「不进表」的用例 | 无 | 否 | 中 |
| 3b-04 ✅ | 市场：`pickPerId` 改成「在当前 BN 装得了的版本里取最高」，索引规则放宽成每个契约版本各留最新一条（脚本、核心包、读取三处是同一条规则）。**必须早于抬契约最低版本**。🔗 10-14 主人定：新版 BN 改读新的滚动 release `extensions` 上的 `marketplace.json`（1.0 新规矩）；旧 release `extension-marketplace` 留给 0.12、从此不动，它的说明写「0.12 专用，已冻结」；格式不顺手改（`issuedAt` 仍是秒、`apiVersion` / `apiRevision` 不改名）；索引里给人看的字这一期不分语言。停着的改动照这个改完再合回。10-15 方案核过：停着的工作区没有提交，从主干新开、把能用的四处照搬；新 release `extensions` 不预先播种 —— 旧索引里的条目都是第 1 版契约，新版 BN 按「版本太旧」不收，搬过去也装不了，第一次发版由第一个第 2 版拓展的 tag（3b-44 的桥）建出来，早于第一版 alpha；旧 release 的说明改成「0.12 专用，已冻结」是改公开内容，主人亲手或明说才做；加一道守卫钉住客户端地址里的 release 名与两个发版脚本的 `TAG` 一致。落成（10-16）：四个提交 —— 核心包的索引校验与发版脚本的去重键带上契约版本（同 id 同档每个契约版本各留一条，「只许往前走」只在同一个契约版本里比）；服务端在这台 BN 装得了的里取最高，一条都装不了才画最高那条的灰卡，面板那张卡与安装下的是同一条；新版 BN 读 `extensions` release，守卫钉住客户端地址与两个发版脚本的 release 名一致；文档改到现状。新 release 不播种，第一次真发拓展时才出现，在那之前新版 BN 的官方源显示「拿不到」 | 无 | 否 | 中 |
| 3b-05 ✅ | 指令：`run` 返回结果形状，失败回话（ADR-0031 决策 1 第三件）。落成（10-13）：办不成的指令返回失败，由分发器统一回「『主人敲的那个词』没办成：原因」；抛错回「出错了，详情在日志里」并记 error 日志（以前不回话）。失败的话原先集中在 `runtime/command-texts.ts`，3b-09 收进了服务端字典（`apps/server/src/i18n/`）。`signal` 仍没加 | 无 | 否 | 中 |
| 3b-06 ✅ | 通用的 `login [来源]`；`status` 的「登录」行改读来源登记表；对拍 N17。落成（10-13）：「带登录的来源」现读来源登记表（视图为此多带了来源键）；`login` 只有一个来源直接扫、有好几个不带词就列出来、带词先认键再认名字；`status` 每个带登录的来源各一行「<名字>登录：<状态>」，某个来源的读口抛了那一行写「状态读不到」、别的行照出；入口不再为这两条指令直读 B 站登录系统；N17 转成对拍行 P21 | 3b-05 | 否 | 中 |
| 3b-07 ✅ | `colorFromUid` → `colorFromSeed`（data-model 改名批里写了、原先没有片认领）。落成（10-13）：只做了改名表那一行的前一半；后一半「删掉 `UpColorIdentity`，取色直接收 `Identity`」随 3b-24（它剩下的最后一个真调用方是首页粉丝面板那一行，条目今天还是 `uid` / `extensionId` / `externalId` 三格） | 无 | 否 | 小 |
| 3b-63 ✅ | B 站请求层给 wbi 一族加熔断（主人 10-24 定方案甲。起因：账号被长期风控时，直播的房号解析与预检每位 UP 稳态每小时约 6 发、随 UP 数线性涨，还每 30 分钟扎堆一起发；风控层只管显示，没人读它决定发不发）：`wbiGet` 持续撞 `-352` 就开闸，窗口沿用直播长尾那张 60s / 5m / 15m / 30m 的表；开着时当场回 `RiskControlError`，不出网、不清共用的 wbiKeys；到期只放第一个调用出网试探，其余合流等它的结果；用时间戳、不另开定时器；失败形状与上报不变，风控层照旧；主人重新登录（登录代前进）时清掉。名字（主人 10-24 定）：`bilibili/api/wbi-breaker.ts` 的 `createWbiBreaker` / `WbiBreaker`，中文「熔断」，词表加一行；那张表搬进 `bilibili/api/`、改叫 `RISK_BACKOFF_STEPS_MS` / `riskBackoffStepMs`，直播从那里 import。同片并进的（主人 10-24 定）：① HTTP 412 算风控，请求层翻成 `rate_limited`、不再连发 4 次，wbi 一族撞上也计入熔断 —— 资料刷新撞 412 不退避、预检撞 412 开机那次直接停监听，由两处现有的风控分支自己接住；② 关注同步撞风控照 `-101` 那套：批量查询撞上整批跳过、不降级成逐个写，逐个写撞上停下这一批。没选：整个账号全停的总闸（`-352` 常只针对某个接口或指纹，会把还拉得动的动态一起停掉）、解除时唤醒（会碰 `listener-manager` / `room-context`，可能和 3b-47 相交）、只错峰（总量仍随 UP 数线性涨）。落成（10-24）：① 请求层：`RiskControlError` 挪进 `bilibili/api/risk-control.ts`，多一格可选 `upstreamCode`（持续 `-352` 带 `-352`；HTTP 412 不带，主会话照 ADR-0026 决策 1 定：412 是 HTTP 状态、不是 B 站的码，原话进 `message`）；请求客户端撞 412 抛它，`Api.retry` 对它一律不重试；12 个回 `Result` 的方法共用收口 `retryResult`，把它翻成 `rate_limited`（四个 wbi 方法各自那段 catch 并掉）。② 熔断 `createWbiBreaker`（`bilibili/api/wbi-breaker.ts`）包住 `wbiGet`，按 `Api` 实例记、`loginEstablished` 时清；当场回绝的原话写英文（带剩几秒与上一次的原话），开闸、升级、解除记中文日志；试探撞连不上、超时这类什么都不说明的，状态不动、下一个调用接着试探（主会话照「失败原因分三档」定）。③ 表搬家：`RISK_BACKOFF_STEPS_MS` / `riskBackoffStepMs` 住 `risk-control.ts`，`room-session.ts` 与 `listener-manager.ts` 经 `api/index.js` 取。④ 关注同步（`bilibili/follow-sync.ts`）：关系查询撞风控整批跳过、不降级、这一批不报 `follow_failed`；逐个 `follow()` 撞风控时撞上的那位照报、随后停下这一批。⑤ 词表加 `breaker` 一行；ADR-0026 决策 4 与 subscription-sources 记了 🔗。测试在 `Api` 公有方法（`http-412-risk`、`wbi-breaker-api`，只假 `Date`）与熔断模块（`wbi-breaker`，注入 `now`）两层，`follow-sync` 加两条。不动盘，没碰对拍与棘轮表；真机没验 | 无 | 否 | 中 |
| **乙 多语言地基（ADR-0037 决策 16）与全局时区** | | | | |
| 3b-08 ✅ | 「写死的中文」只降不涨的计数守卫。排在 3b-09 与头一批新文字收进字典之后开：开早了，字典落地之前新写的字只能先集中放在文案文件里，每一片都会把计数顶高。范围是服务端、面板与各包（不含测试、日志、开发版的调试面板），单位照别的语法树棘轮按文件数字符串节点 | 3b-09 | 否 | 中 |
| 3b-09 ✅ | 字典机制、两端的语言 store、钉键与占位符的检查、调用处参数名对占位符的检查。主人 10-13 定：核心那一层放进 `packages/internal`，开一个新的零依赖子路径（被否：单开一个包）；译文的 JSON 住服务端与面板各自那边。公开接口主人 10-13 定：核心 `mergeDict` / `translate` / `createI18n`，服务端 `i18n` 与 `t`，面板 `i18n` 与 `useT()`。落成（10-16）：核心在 `packages/internal` 的零依赖子路径（`createI18n`、`mergeDict`、`translate`，只认字典的自有键）；语言 `zh-CN` / `en` / `ja`，译文住两端各自的 `locales/`，女仆层 `zh-CN.maid.json`；服务端 `i18n` / `t`，今天的指令回话原样进 `zh-CN.json`；面板 `i18n` / `useT()`。两道守卫：`i18n-dicts` 钉键形、占位符、复数类别、女仆层与各语言齐不齐；`i18n-call-sites` 钉调用处的键与参数对占位符，文件加载或对象构造时取字判红（主人 10-16 定加），面板组件里直接调 `i18n.t` 判红，认不出的写法一律红、白名单按数目对账 | 无 | 否 | 中 |
| 3b-10 ✅ | 语言与口吻两项设置，接到 store；升级上来的默认简体中文。口吻那一项的默认值第 4 期定之前取女仆（今天写死的话全是女仆口吻，行为不变），默认只写在规则里、不落盘 | 3b-09 | 否（缺的格靠默认补，开工时核） | 小 |
| 3b-11 ✅ | 全局时区设置（ADR-0021 决策 43，默认 `Asia/Shanghai`；卡上的时间今天按机器本地时区排） | 3b-10 | 开工时核 | 小 |
| 3b-12 ✅ | 文字模板与内置人格改成「没改过的不存、跟随当前语言的默认」；并掉直播文案那份重复的默认。**排在动盘队列的最后**：它要拿最终的默认文案判「没改过」。🔗 10-24 落成：出厂文字模板与四份内置人格按语言各一份，住 `packages/internal/src/locales/<语言码>.json`，经两端共用的零依赖子路径 `@bilibili-notify/internal/builtin-texts` 读取；今天只有 `zh-CN` 有内容，其余语言空、拿简体打底。文字模板只存改过的，服务端读取时按「全局 → 订阅覆盖 → 当前语言出厂」补齐，换语言不写盘；「默认文案有更新」只认存着且改过的文字，账本记第一次修改时的简体出厂指纹。**主人 10-24 定**：这批出厂字两端都要，因此共用一份、不按 ADR-0037 决策 6 在服务端与面板各放一份；内置人格也只记 `ai.removedBuiltinPresets`（缺 = 一份没删）与主人自建的 `ai.presets`，内容随当前语言取，这样新内置会自动出现、删过的不回来。顶层人格三格删掉，迁移修订号 52、备份版本 22（21 及以前拒收），N08 转成对拍 P46。 | 3b-10、3b-21 | 是 | 大 |
| **丙 直播（`runtime/engines.ts` 同时记在五张棘轮表里，这一组与丁组在它上面一个接一个）** | | | | |
| 3b-13 ✅ | e2e 钉 B 站直播的旧行为：开播、下播、断流接续、漏收兜底，外加醒目留言、会员、特别弹幕、特别进场各一条内容快照。只加测试，不动产品代码。落成（10-13）：`apps/server/src/__tests__/bili-live-e2e.test.ts` 40 条，走真的 `createEngines`，假件只有 B 站接口对象、弹幕连接、出图器、平台适配器四样；定案要改的行为在用例名里标了「今天的行为」。记录见下「3b-13 已落」 | 无 | 否 | 中 |
| 3b-14 ✅ | 直播监听的唯一判定进核心包，今天的三份并成一份。**有行为变化**：首页「直播」那一格今天按「有没有配推送目标」判，改成只看开关。落成（10-13）：`needsLiveMonitor` 住 `packages/internal` 的零依赖子路径 `live-monitor`，入参是一组布尔；首页「直播」那一格与「有 N 位订阅没开直播推送」那句都改问它；B 站直播引擎里两个同名的转发方法改叫 `needsListener`；判定进了「只许有一个家」的点名表 | 无 | 否 | 中 |
| 3b-15 ✅ | 特别弹幕、特别进场的装配抽进 `live/`。落成（10-13）：`live/special-users.ts` 的 `pushSpecialDanmaku`、`pushSpecialUserEnter`（开关、名单按观众 id 判、套文案、交一句文字给绑好的发送），两句文案的渲染搬进 `live/live-text.ts`；B 站会话只剩把帧翻成中立的值与绑发送。一处有意的行为差：进场那一支也看引擎是否已拆（原来只有弹幕那支看） | 3b-13 | 否 | 小 |
| 3b-58 ✅ | 外部 id 的格式由来源声明（主人 10-15 定，ADR-0021 决策 14 下的 🔗）：`SourceDescriptor` 加 `externalIdRegex?`（正则源码、整串匹配；拓展清单同名字段，编译不过拒收；源码与被核的值有长度上限），B 站声明纯数字；核心在新建订阅处照它核 `identity.externalId`，撤掉路由里的 `biliExternalIdRefusal`（B 站替身棘轮 `routes/subscriptions.ts` 8 → 7）。3b-16 的特别关注名单 `id` 用同一个核法。开工先核描述符新格会不会碰对拍文件的成员棘轮。落成（10-16）：`SourceDescriptor.externalIdRegex?` 与拓展清单订阅源的同名字段（照 `blockRegex` 那道体检：长度、疑似灾难性回溯、编译得过）；来源登记时同样体检，不过的拒收；核法是 `subscriptions/external-id.ts` 的 `externalIdRefusal`，新建订阅在分岔之前核；B 站声明纯数字；对拍 P23（合格式的停在「装着的拓展」那道闸，建成由拓展建订阅那组测试钉着）；B 站替身棘轮该文件实为 8 → 6（文件头注释里的「B 站」一并去掉）。看得见的变化：B 站新建订阅的 id 不是纯数字时，报错的话改成「B 站的外部 id 格式不对，没法新建订阅」 | 无 | 否 | 小 |
| 3b-16 ✅ | 特别关注名单改成一张 `specialViewers`（条目 `SpecialViewer { id, note?, features }`，`features` 装特性键、必填至少一个；死格 `template` 退役）；两把特性键改名 `specialDanmaku` → `viewerChat`、`specialUserEnter` → `viewerEnter`（设置的开关 / 路由 / 文案键、订阅的覆盖与路由、历史行的 `feature` 值都在盘上，一次迁移；专门的测试钉住老键 `specialUsers` 上的名单一个不少地到新键）；「要不要监听」改成「五把直播类开关任一开着，或某把特别开关开着且名单上有人带它」（迁移记账本里留一份冻住的旧读法）；3b-15 入口的名字跟着两把键改；面板两节名单与开关最小跟改。核心里直播一侧的 `danmaku` 换成 `viewerChat` 一族（`ViewerChatCollector`、`recordViewerChat`、`viewerChatCount`，不上盘）可以先单做一个提交。对拍 N10 里「按 `viewer.id`」那一项；事件载荷棘轮的最后一格卡在它上。🔗 10-16 落成：四步齐了 —— 收集器改名；特别观众入口改名；名单与两把键搬家（动盘，修订号 45、备份 18，迁移冻住了 0.x「名单有人就监听」的旧读法）；监听判据改成「五把直播开关任一开着，或特别开关开着且名单上有人带这一把」，`needsLiveMonitor` 一个函数说全，B 站视图与 update op 带两把开关，全局默认或订阅自己翻了开关都经同一条 update op 补开或拆掉监听。看得见的变化：只配了名单、特别开关关着的订阅不再连直播间，首页说它不会被监听，统计不再记它的直播 | 3b-15、3b-58 | 是 | 大 |
| 3b-17 ✅ | 醒目留言的装配抽进 `live/`。落成（10-13）：两条门槛函数搬进 `live/interaction-gates.ts`；`live/superchat.ts` 的 `pushSuperchat`（过门槛 → 确定要出卡才取观众头像 → 出卡 → 出不了卡发一句兜底文字），B 站会话只剩翻事件、拼兜底那句字、绑取头像与发送。一处有意的行为差：从前发图那一次抛了会被当成出卡失败、再补发一句文字（等于可能重发），现在发送抛了原样往外抛、不补发 | 3b-15 | 否 | 中 |
| 3b-18 ✅ | 会员的装配抽进 `live/`；上舰观众头像撞风控的处置；直播这一侧的风控码按定下的口径统一。🔗 10-13：抽装配那一半已落 —— `live/membership.ts` 的 `pushMembership`（过门槛 → 自定义文案 / 出卡 / 兜底三支），B 站会话只剩翻事件、查档位表、挑生效的文案包、拼兜底那句字、绑「取徽章」「取观众头像」与发送；会员的推送照旧不过串行闸（原先说它也过闸的那句注释改对了）。一处有意的行为差：发卡那一次抛了不再补发兜底。风控那一半：B 站在 `bilibili/` 里建一张共用的「数字码 → 标准码」翻译表（`-352` / `-412` / `-799` / `-509` → `rate_limited`，`-101` → `unauthorized`，`-403` 由各接口自己判，没对照的 → `unknown` 并记一次 warn），请求层在接口回来时查一次；拉动态、直播预检、上舰观众头像、cookie 续期改读标准码（续期只在 `unauthorized` 时登出）。粉丝轮询那几处留给 3b-24 | 3b-17 | 否 | 大 |
| 3b-19 ✅ | 词云与直播总结的装配抽进 `live/`。🔗 10-13：第一步已落 —— 弹幕收集器、停用词、词云生成器、总结请求器连同测试搬进 `live/recap/`，收集器改按订阅 id 记账（查过：房号还是空的时候不会登记也不会喂入，换键不改行为），总结的模板渲染搬进 `live/live-text.ts`、收粉丝团名字的值。第二步也已落 —— 「下播时出附加项锚点」进了 `live/recap/recap-anchors.ts` 的 `recapAnchors`（取快照、按订阅额外的停用词再滤、词云与总结各起各的、各交一个锚点），锚点的类型搬到 `live/live-types.ts`；B 站会话只剩取值、调它、给锚点包上「引擎拆了就不发」。推出去的词云图与总结文字不变 | 3b-18 | 否 | 中 |
| 3b-20 ✅ | 替拓展跑的那套场次引擎升格成核心的 `live/`（只搬家改名，行为不变）。🔗 10-13：勘察查实它与 3b-17 至 3b-19 的文件面不交，提前开工。第一步已落 —— 那套引擎唯一回头依赖 `engines.ts` 的是 `LiveWorkSettings` 这个类型，而它原是从 B 站的订阅视图里挑出来的；现在改成在 `live/live-settings.ts` 里显式写字段，B 站的视图反过来继承它，核心不再经它牵着 `bilibili/`。原先打算先搬出 `engines.ts` 的 `boundLivePush` 等几个小件不搬了（它们牵着 `engines.ts` 的私有函数，搬了反而要回头引）。第二步也已落 —— 在播表、场次引擎、直播推送的绑定、上报翻成卡输入四个文件连测试搬进 `live/`（`live-table.ts`、`live-sessions.ts`、`live-push.ts`、`live-card-input-from-report.ts`），去掉 `Extension` 前缀（名字见下「新开的缝」那张表），场次变化联合的判别键 `type` 改成 `kind`；总线事件名、契约类型、`extensionId` 等字段与日志前缀都没动，字段对齐留给 3b-22 / 3b-23 | 3b-19 | 否 | 中 |
| 3b-21 ✅ | 其余 6 条直播文案的占位符改名、`-key` 老写法改写、`{mdn}` → `{fanclub}`、资料加 `fanClubName`，删 `applyTemplate`；模板变量表与「模板变量可满足性」守卫同片开；对拍 N08 只落 `{postNoun}` 那一半（P04）。默认作品文案加 `{postNoun}`（ADR-0028 决策 3）；`fanClubName` 这一片先加资料的格与 `{fanclub}`，取值在 3b-24 之前照旧从直播那边传。对拍 N08 里要直播交得出的几样等 3b-22，N08 随 3b-22 收尾 | 3b-19 | 是 | 中 |
| 3b-22 ✅ | 来源接口加 `reportLive`、`fetchLiveStatus`、`liveInteractions`，B 站直播翻成中立信号并进来源，B 站那套里的场次状态删掉；周期计时归核心；直播拿上报器的过渡接线拆掉；会员档 key 的命名空间与「来源声明的图」；对拍 N03、N04、N10、N11。**独占**。开工第一步先把核心场次引擎里绑着「拓展」在册判断的几处抽象掉（今天它只服务拓展）。照定案：周期拿不到房间信息跳过这一轮、记问题、不停监听（今天有两处在停，都要改）；漏收下播的兜底与周期推送拆开，凡在一场直播里的订阅都按间隔核一次，周期推送关着只核不推、间隔默认 1 小时；重连后核对发现已下播也走下播那条路；互动走回调；开播看 `liveStart`；漏收下播的时长算到发现的那一刻。对拍 N08 在这一片收尾。🔗 10-21：已落成。核心 `LiveSessionEngine` 统一接推送式信号与 `fetchLiveStatus`，B 站直播间连接搬进来源并上报中立信号与四种互动；`LiveSettings` / `liveSettingsOf` 收整份直播设置，徽章引用写进来源描述符。进程内对拍现为 35 行对拍、11 行不开。 | 3b-20、3b-18 | 否 | 大 |
| 3b-23 ✅ | 直播事件改名并去掉 `uid`（`live-session-changed`、带订阅 id 的 `live-viewers-changed`）；场次多收的字段；会员与醒目留言的总线事件；面板两处读者与在播快照同片最小跟改；对拍 N13 的一半。落成：`LiveSession` / `LiveSessionChange` / `LiveSessionEndReason` / `LiveSessionInteractions` 住 `internal` 的 `live.ts`，对外是 ISO 纯数据投影，用 `isLive` / `endedAt`，每支带 `subscriptionId`；场次按开播时刻分，另有已知开播时刻时上一场 `superseded`，断流等待里不分；结束原因五种的 `signal` / `grace-expired` / `poll` 推下播卡，`stopped` 的起因只进日志；`noteInteraction` 攒互动汇总且与推送开关无关，会员与醒目留言不开总线事件，汇总随场次结束帧交统计；`live-session-changed` 与 `live-viewers-changed` 进总线并由 `push-events` 原样转发，只带实际带来的人数格，旧 `live-state-changed`、`extension-live-session`、`extension-live-changed` 与 R1 输出删掉；统计的 `stats/live-source.ts` 一支记所有来源，B 站登录失效先忘在飞场次，场次行收标题、分区与五类互动汇总；`GET /api/live/listening` 合用 `LiveListeningEntry`，面板从场次引擎维护在播并就地补行；N03 转成 P36，N13 只剩粉丝一半、等 3b-24。交给后面几片：事件载荷棘轮只剩 `fans-refreshed` 一行、`routes/stats.ts` 的 B 站替身剩粉丝那 4 处（3b-24 / 3b-26）；uid 棘轮 `runtime/engines.ts` 剩 9 处全是关注同步（3b-25）；统计适配器合成 `bindStatsRecorder` 未做。 | 3b-22 | 否 | 中 |
| **丁 资料、关注、统计** | | | | |
| 3b-24 ✅ | 来源的 `fetchProfile`，资料刷新由核心定时调；粉丝轮询并进去、事件改名 `followers-refreshed`、涨粉起点退役；粉丝轮询这一侧的风控码统一；锐评里的名字链统一；粉丝面板的条目改成带身份之后删掉 `UpColorIdentity` 与 `upColor`（3b-07 留下的后一半，核心包那个文件在 uid 棘轮里剩的 4 处随之清掉）；对拍 N02、N13 的另一半。粉丝轮询改用 3b-18 那张翻译表；撞风控进 B 站的风控层（路名 `profile`，只进表不私聊）；`fanClubName` 由 B 站从直播时取到的主播信息记进自己的 `ctx.state`、`fetchProfile` 交资料时带上，不为它多发请求；AI 工具 `get_creator_profile` 对没订阅的人的回落（3b-33 留的口）在这一片接上 `fetchProfile`。3b-18 留下的两处同在这一片：搜人（`search-creators.ts`）自己查表、每次撞到表外码都 warn，要改成吃请求层的翻译与每码一次的去重，`searchByType` 一并改结果形状；`runtime/fans-poller.ts` 里提到已删的 `classifyRefreshCode` 的注释随整段重写改掉。登录取码（`auth/login-flow.ts`）手写的 `-352` / `-403` → `rate_limited` 也还在，不属于任何一片，开工时顺带问主人要不要一起改。落成（10-23）：① B 站卡片、搜人与登录取码统一经标准失败码，表外码每 `Api` 实例每码只 warn 一次，`searchByType` 回 `Result`；② `Source.fetchProfile` 成为必备成员，核心经 `fetchSourceProfile` 统一调，B 站从用户卡取名字 / 头像 / 简介 / 粉丝数，头像与粉丝牌名住自己的 `ctx.state`；③ `ProfileRefresh` 按 `profileRefreshCron` 刷新启用中的订阅，资料缓存与粉丝样本共用一套写入口，新建订阅单条刷新，`not_found` 记 `creator_not_found`；④ `fans-refreshed` → `followers-refreshed`，条目只带订阅 id、身份、当前数、时刻和三种增量，`GET /api/stats/followers` 同形；⑤「订阅以来」取时序第一条样本，统计关着仍给当前数与订阅以来，24h / 7d 空；⑥ 当前粉丝与「在记」对所有来源同一记法，`routes/stats.ts` 的 B 站替身清零；⑦ `externalIdNoun` 与 `displayNameOf` 已落，女仆订阅视图、直播卡、互动卡、拓展作品与单人锐评同走名字链，粉丝卡按 `identityColor` 取色；⑧ 女仆对没订阅的人回落来源 `fetchProfile`，不写缓存；⑨ 对拍现为 P01–P40、共 48 行，N02 → P39、N13 → P40；⑩ 事件载荷棘轮已空，uid 棘轮为 `compose.ts` 3、`routes/cards.ts` 33、`routes/subscriptions.ts` 11、`runtime/engines.ts` 9、`runtime/follow-sync.ts` 13、`packages/ai/src/tools.ts` 20；B 站替身棘轮里 `routes/stats.ts` 为 0。交给后面：盘上 `fansBaseline` 与资料缓存整族改名归 3b-62；面板身份标签、订阅卡裸 id 与「复制 UID」归第 4 期；拓展清单收 `externalIdNoun` 归谁未定 | 3b-23 | 否（运行时不再读 `fansBaseline`，盘上残留交给 3b-62） | 大 |
| 3b-62 ✅ | 资料缓存整族改名：`CachedProfile` → `CreatorProfile`、`sign` → `bio`、`fans` → `followers`、`lastRefreshedAt` → `refreshedAt`，`avatarUrl` 退出核心缓存（B 站的头像地址已住 B 站自己的状态），文件改名 `subscription-state.json`；迁移里一并丢掉盘上的 `fansBaseline`（3b-24 定：那一片不动盘）；迁移里还要把 0.x `sub-runtime.json` 的 `roomId` 按订阅身份拆进 B 站状态 `runtime/bilibili/state.json` 的 `room:<uid>`（键与值的形状照 `bilibili/live/room-ids.ts`），`followed` / `followError` 丢掉（3b-25 不动盘，主人 10-23 定并进这一片）。落成（10-24）：① 整族改名：`CreatorProfile` / `CreatorProfileSchema`、`SubscriptionState` / `SubscriptionStateStore`（`createSubscriptionStateStore`、`runtime/subscription-state-store.ts`、`SUBSCRIPTION_STATE_FILE`、`pruneOrphanSubscriptionState`），属性名 `cachedProfile` 照 data-model 不改；字段 `sign` → `bio`（空串缺键）、`fans` → `followers`、`lastRefreshedAt` → `refreshedAt`，`avatar` 只收图库引用，`avatarUrl` 退出核心缓存，面板头像不再退到远端网址；② 新建订阅的请求体在契约里自立 `SubscriptionCreateRequest`，那一格照旧叫 `cachedProfile`（主人 10-24 定），形状 `{ name, avatarUrl?, followers? }`，面板草稿另持候选资料；③ 迁移修订号 51（50 归 3b-35）：0.x 资料迁成新形状与新文件名，`fansBaseline` / `followed` / `followError` 与 B 站远端头像地址丢弃（开机资料刷新首轮重抓），B 站订阅的 `roomId` 拆进 `runtime/bilibili/state.json` 的 `room:<uid>`（同一 uid 取订阅文件里第一条有效房号，已有键原样保留），拓展与对不上订阅的房号丢弃，订阅文件读不到时资料照迁、房号不写；迁移报告的新句子进简体字典；备份版本 21 不抬（备份不带运行态文件）；④ B 站 devtools 假动态的作者头像改由 B 站来源的 `profileAvatars()` 从自己的状态取，`compose.ts` 不再按 uid 取头像；⑤ 棘轮数不变。交给后面：拓展协议（候选与资料上报）里仍叫 `fans`，由核心边界翻成 `followers`，随 3b-42 换上报形状时一起改 | 3b-24、3b-25 | 是（迁移修订号 51；备份版本 21 不抬） | 中 |
| 3b-25 ✅ | 关注同步搬进 B 站来源：`roomId`、`followed`、`followError` 进 B 站自己的 `ctx.state`（房号解析 `listener-manager.ts` 的 `resolveRoomId` 撞持续 `-352` 今天被吞成一条 warn：这位 UP 的直播会话不起、不报问题、不重试，是既有缺口，房号搬家时一起处理，重试多久、报什么问题码开工时问主人）；补关注在名单变化回调里异步做，`-101` 整批跳过、不降级；失败报 `follow_failed`（带 `externalId`、挂在那条订阅上、只进表）；新建订阅的回应不再带关注结果。面板跟改一小块（提前到 3b）：订阅列表的回应由宿主把挂在这条订阅上的问题一并带上，订阅卡通用地显示它们（去掉「是不是 B 站」的判断），问题变了面板刷新。落成（10-23）：① `fetchUserInfo`、`follow`、`fetchRelations` 进请求层的结果形状（`0` / `22014` / `22001` 在 `Api` 里折成成功；卡片预览解析房号失败时报错带上失败码与原因）；② 房号全仓一处解析：`bilibili/live/room-ids.ts`（`createRoomIds`），记进 B 站 `ctx.state` 的 `room:<uid>`，只记名单里的人、名单少了人删键，同一人在途合并、出网间隔 300ms；`compose.ts` 的 `liveRoomIds` 过渡口与 `SubRuntime.roomId` 删掉，开发场景经来源的 `liveRooms()` 挑房号；③ 主人 10-23 定（房号 = 甲）：解析房号撞风控进风控层路 `live:<uid>`、只进表，按 60s / 5m / 15m / 30m 之后每 30 分钟重试、不放弃，与预检共用一张退避；解出来真解除，不再监听或来源停下时静默清；连不上与表外码同一张退避、只记日志，没开通直播间与没登录不重试；`fetchLiveStatus` 房号解不出来时原样回失败，不再报房号为空串的那条；④ 关注同步搬进 `bilibili/follow-sync.ts`（`watchFollows`）：已登录开机、登录恢复（`auth.onChange`）跑全量，名单变化只对新进作品范围的人；批量查 `unauthorized` 整批跳过、不降级，单个关注撞 `unauthorized` 停下这一批；失败报 `follow_failed`（B 站分层上报器第三层、带 `externalId`、`lasting`、只进表），成功或批量查到已关注就清，离开范围静默清；`followed` / `followError` 哪里都不存（与本行原文不同：依据 subscription-sources 3b-25 那条「只在内存、不再存盘，重启后由下一轮关注同步重报」）；关注撞风控只报 `follow_failed`、不进风控层（ADR-0025 决策 11 把关注列在「各项请求失败」那一层）；核心 `createEngines` 的关注同步与 `auth` 选项、路由新建时的当场关注、`subscriptionsOfFeature` 删掉；⑤ `SubscriptionDTO.problems` 必带（问题表里 about 这条订阅的，按 `since`），GET / POST / PATCH 都带，面板订阅卡每条一个 `ErrorNote`、不分来源与 code，`problems-changed` 时订阅列表重取，`followed` / `followError` 退出契约与面板；对拍 P11 扩到订阅回应；⑥ 不动盘（主人 10-23 定动盘 = 丙：0.x 的 `roomId` 拆进 `room:<uid>` 并进 3b-62 的迁移）；⑦ 棘轮：uid `runtime/engines.ts`、`runtime/follow-sync.ts` 两行删，`routes/subscriptions.ts` 11 → 8；B 站专有词 `compose.ts`、`runtime/sub-runtime-store.ts` 两行删，`routes/cards.ts` 20 → 18；B 站替身 `runtime/engines.ts`、`runtime/follow-sync.ts` 两行删，`routes/subscriptions.ts` 6 → 5、`routes/cards.ts` 8 → 7；入口咽喉 `runtime/follow-sync.ts` 一行删，`routes/subscriptions.ts` 3 → 2，`runtime/engines.ts` 与 3b-34 合计 8 → 4；import 边界 `routes/subscriptions.ts`、`runtime/follow-sync.ts` 两行删；手写结果 `bilibili/api/follow.ts` 一行删；写死中文 `UpCard.tsx` 9 → 8。交给后面：0.x 的 `roomId` 拆进 B 站状态归 3b-62；「UP 没开通直播间却开了直播推送」挂问题归 3b-26（主人 10-24 定，已落：问题码 `live_room_not_found`，见 3b-26 行） | 3b-24 | 否（主人 10-23 定：0.x 的房号拆进 B 站状态并进 3b-62 的迁移） | 中 |
| 3b-26 ✅ | 统计「这个小时在记」改成核心自己算；统计里 B 站那几处搬进 `bilibili/`；入口里两行接线的测试；对拍 N16。落成（10-24）：① 「搬进 `bilibili/`」落成「消失」：B 站那两条统计规矩写成对一切在册来源成立的中立规则，新模块 `stats/registry-source.ts`（`attachRegistryStatsSource`）—— 来源在登记表里，且没有登录口或登录口现读是 `logged-in`（`confirming` 不算），就按每条订阅的 `recordsPosts` / `recordsLive` 记当前小时；挂上时、每 `RECORDING_CHECK_MS`、`subscription-auth-changed` 时各看一眼；登记表里没有的键（今天的拓展订阅）照旧由拓展适配按上报记；② 主人 10-24 定间隔 5 分钟 → 1 分钟，不给登记表开 `onChange`（来源登记那一刻没有信号，开机后最多 1 分钟记上）；③ 登录丢了忘在飞场次：同一模块听 `subscription-auth-changed`，现读到 `expired` / `logged-out` 就忘那个来源名下的（不记上一次状态，与方案原文不同：来源登记时就已登录不会有事件种下记录），不补 end 帧、之后的 end 不写、按同一开播时刻认回来照旧；统计不再听 `auth-lost` / `auth-restored`；④ 主人 10-24 定「来源在跑」两种说法分开：统计口径看登录、只住这个模块；作品入口的闸与女仆查直播仍用 `SourceStatusReader`（在册即在跑），合成一个运行状态读口归第 4 期（N15）；⑤ 删订阅清统计文件收成记录器里一个不分来源的监听；`stats/bili-source.ts`、`stats/login-binding.ts`、记录器的 `bindLoginState` 与入口那行回填删掉；统计里 `fans` 的旧叫法改成 followers（`recordReportedFollowers`、`profileRefreshCron`、`followersSampleGapMs` 等）；⑥ 入口两行接线 —— 递给资料刷新的 `isStatsEnabled`、递给女仆统计工具的 `isEnabled` —— 由 `stats-mixed-branches-e2e` 两条真起服务的用例钉着；⑦ 对拍 N16 → P45，`PARITY_ROWS` 51 行：对拍 45、不开 6；⑧ 棘轮：B 站替身 `stats/bili-source.ts`、`stats/extension-source.ts`、`stats/recorder.ts` 三行删；⑨ 统筹会话带来的「`routes/stats.ts` 粉丝那 4 处」3b-24 已清零；`bindStatsRecorder` 这个名字仍没落，只合到在册来源一支，拓展上报一支随 3b-42 并入。同片另落三件（主人 10-24 加的，各一个提交）：对拍 P30 偶发红（Node 计时器比墙钟早到一两毫秒、进程内来源答得更快时同一格问两次、时长少一秒；`live/live-sessions.ts` 把这一格的时刻带进回调、早到就补等）；QQ 网关测试偶发超时（测试假网关绑通配地址、macOS 上挡不住别的测试进程在 127.0.0.1 上绑同号端口；改绑 127.0.0.1，只动测试）；「UP 没开通直播间却开了直播推送」挂问题 `live_room_not_found`（挂在这位 UP 名下、只进表、订阅卡显示、不私聊；离开直播监听名单静默清，之后解析成功清）。交给后面：3b-42 把拓展来源登进登记表之后，没有登录口的拓展会被当成在册即在跑，那一片要定拓展来源的在跑怎么算 | 3b-24 | 否 | 中 |
| **戊 链接预览、原生分享、AI** | | | | |
| 3b-27 ✅ | 两张登记表：链接解析器、AI 工具提供方；`compose.ts` 与来源上下文各加登记口。链接那一半随 3b-28 的重写本体一起落了，AI 那一半并进 3b-34。🔗 10-13：链接那一半（核心包的 `LinkResolver` / `LinkPreview`、`link-preview/registry.ts`、来源上下文的 `registerLinkResolver`）做完了，但单独提交不了 —— 对拍的成员棘轮要求来源上下文的新成员先有对拍行管着，而那一行就是 N07，所以并进 3b-28 的重写本体一起落；AI 工具提供方那张表在 3b-34 之前没有登记的人也没有读的人，随 3b-34 造 | 无 | 否 | 小 |
| 3b-28 ✅ | 链接预览重写（ADR-0029）：先补一条走假解析器的端到端钉子，再改成「核心的门加登记表」，B 站解析器搬进 `bilibili/`，目录改 `link-preview/`，冷却键换新；视频封面；对拍 N07。🔗 10-13：第一步已落 —— `link-parser`、`link-reply`、`link-scope` 三个文件连同测试从 `runtime/` 搬进 `link-preview/`，名字与行为都没动，四张按文件记账的棘轮表跟着换了路径。重写本体同日已落 —— 门不再认识 B 站：用通用网址正则挑候选，按登记先后问在册的解析器认不认，取前三个被认领的；冷却每条链接记两把键（联网之前按链接原文，解析成功后按解析器交的规范 id），同一条消息里指着同一个东西的几种写法只出一张（冷却关着也一样）；B 站的解析器、视频链接的认法、视频翻成作品都搬进 `bilibili/`，由 B 站来源在 `start(ctx)` 里登记；原生分享由解析器交中立描述、门先翻成今天的小程序卡载荷（不动盘）；对拍 N07 转成 P22；四道棘轮随之下调。看得见的变化：同一个视频的 av 链接与 BV 链接现在共用冷却；回原生分享时也会抓一次封面。门改名 `LinkPreviewer`（主人 10-13 定）已作为一个机械改名提交落地（`createLinkPreviewer`、`LinkPreviewerOptions`、文件 `link-previewer.ts`，`extractUrlCandidates` 同时改为 `extractUrls`、文件 `extract-urls.ts`，行为不变）。还没做：解析器交的 `appId` 先用来源键占位，3b-31 定对照表时再定 | 3b-27 | 否 | 大 |
| 3b-29 ✅ | 设置 `linkParsing` → `linkPreview`，五格：总开关（默认关）、默认回不回、回复形式、按目标的例外、`cooldownSec`（主人 10-14 定加回总开关、留冷却；总开关与「默认」两格的名字施工时照规范起、列给主人）；迁移一一对应、行为不变；带 `linkParsing` 的名字机械换成 `linkPreview`；面板最小跟改 | 3b-28 | 是 | 中 |
| 3b-30 ✅ | 入站链接的来源标记：`miniAppCardLinks` 删掉，适配器只交卡片里的链接 `sharedLinks: { url, kind: "card" \| "nativeShare" }[]`，正文链接仍由核心从 `text` 里挑（内部记 `"text"`）；删 B 站域名预筛。只动 BN 内部；桥帧不改名，由桥的适配器映射。🔗 落成（10-17）：`InboundGroupMessage` 的两格换成一格 `sharedLinks`（OneBot 小程序卡记 `"nativeShare"`、别的卡记 `"card"`，桥的适配器把线上帧的两格映射成它，官机与开发工具场景交空数组）；门把正文与 `"card"` 的链接合成候选、按网址原文去重，`"nativeShare"` 的不收，行为不变；OneBot 的 B 站域名预筛删掉，别家的分享卡也交出链接，认不认由解析器的 `matches` 说了算 | 3b-28、3b-40 的第一个提交（入站改名） | 否 | 中 |
| 3b-31 ✅ | 原生分享：解析器交中立描述，OneBot 适配器去签；载荷改名；重推原件迁移与守卫 13；webhook 的线上帧。载荷种类 `"miniapp-card"` → `"native-share"`、能力格 `miniAppCard` → `nativeShare`；`appId` 填 B 站 QQ 小程序真实的 appid（施工时从真分享卡里核），OneBot 签名接口不收通用参数就在适配器里放对照表；旧原件迁移补同一个值；回复形式「回文字」发作者名加作品文字（限长）、不带链接 | 3b-28 | 是 | 中 |
| 3b-32 ✅ | AI 工具：失败按结果形状返回、每把工具带标签、面板读下发的标签。🔗 10-13：前两步已落 —— 核心工具与看图按结果形状返回，接口回错、未知工具、别的平台的 id、图片序号不对记成失败（「查了、没有」仍是成功），痕迹的结束事件带上那句话，同一句话照旧喂回模型；聊天里注入的工具也统一成同一种结果形状，读一条不存在的技能记成失败。第三步也已落 —— 皮肤与卡片工坊那几把里三十来处预期内的失败从抛错改成返回失败（码照标准码表：参数与校验不过 `invalid`、点名的皮肤或块不存在 `not_found`、模型没配好 `not_configured`、内置的不能改 `unsupported`、每轮的限额 `rate_limited`、生成没成 `unavailable`），话逐字不变，但喂回模型时不再带工具环给抛错加的「工具执行失败: 」前缀；工具环接到抛错现在记一条 error 日志。标签那一步也已落（服务端这一半）—— 工具类型改叫 `AiTool`，带 `label`、`labelArgs`、`formatLabelArg`；核心那几把「小条上补哪一格入参」是文案里写的再接上参数定义里必填的，不另抄参数名；痕迹的开始事件带 `label` 与 `argText`、结束事件带失败的那句话，三样都随会话落盘并下发；技能列表接口多了每把工具的标签；看图那把新配了标签「查看图片」。面板那一步同日也落了 —— 聊天里的小条只读痕迹自带的标签与入参文字，写死的那张表、三条死标签与扫源码的旧测试都删了；存下来时还没有标签的老痕迹由服务端读会话时现补（不改写盘上的文件；10-17 已撤，见 3b-60）；同一次调用小条上显示的字与改之前逐字相同。留给第 4 期的：失败的那句话面板还没显示、技能编辑器的勾选框还显示工具名 | 无 | 否 | 中 |
| 3b-33 ✅ | AI 工具：中立的几把（参数统一叫 `creator`），订阅视图改读来源登记表；对拍 N18（转进 P25）。来源的 `searchCreators` 这一期造、B 站实现，给 `search_creators` 用（主人 10-14 定提前；路由与面板第 4 期）；统计总开关关着时 `get_creator_posts` / `get_creator_stats` 回 `not_configured`；`get_creator_profile` 对没订阅的人回落调来源的 `fetchProfile`（10-15 主人定，ADR-0030 决策 1 下的 🔗；3b-24 之前先答查不到，回落那一下随 3b-24 接上）；外部 id 的格式照 3b-58 的 `externalIdRegex` 核；过渡期还按 uid 查的两把（`get_user_stats`、`get_user_videos`；10-15 核过，原写三把）在说明里写「B 站的 `creator` 冒号后面就是 UID」。🔗 10-16 落成：四步齐了 —— 在播改读 BN 手里的状态；订阅视图带 `creator`、平台名问来源登记表；`searchCreators` 与 `search_creators`；资料、作品、统计三把读资料缓存与统计仓（统计总开关关着时作品与统计两把回 `not_configured`，资料不受它管；没订阅或已停用的答查不到；一条作品都没记到时说「BN 没记到」，不说「暂无动态」）。内置技能只换了工具名，技能改名归 3b-35 | 3b-27、3b-32、3b-54 | 否 | 大 |
| 3b-34 ✅ | B 站自带的工具搬进 `bilibili/` 当提供方登记，删 `packages/ai` 里的过渡接口 `BiliReader`；对拍 N06。主人 10-23 定：B 站两把参数收 `creator`；提供方自己起本名、宿主加命名空间（「拓展自己起名，我们给它加命名空间」），全名 `<命名空间>__<本名>`，命名空间是来源键换成工具名允许的字符；两把给模型的话进写死中文守卫的白名单。落成（10-23）：① `AiTool` 一族搬进 `internal/ai-tool.ts`，新加 `AiToolProvider { readOnly }`（`chat` / `skills` 没造）；② `SourceContext.registerAiToolProvider` 与登记表 `ai/tool-provider-registry.ts`，键取来源键、来源停下自动撤，本名非法、同组重名、全名超 64、命名空间相撞登记即抛；③ 生成器 `setProvidedTools` 每次请求现取，聊天与「试一句」挂、推送路径不挂，分发与标签按注入 > 提供方 > 核心；技能编辑器的工具名单现取；④ B 站两把搬进 `bilibili/ai-tools.ts`，本名 `get_up_totals` / `get_up_videos`（全名 `bilibili__get_up_totals` / `bilibili__get_up_videos`），别家来源键或坏 id 回 `invalid` 不去查，三个请求改回 `Result`、失败码走翻译表；四条内置技能改用全名；⑤ `packages/ai` 不再有 B 站认知：`BiliReader`、生成器的 `api`、`BILI_UID_PARAM`、`uidRefusal`、`externalIdFits` 删净；⑥ 对拍 P01–P42、共 50 行：P41 三把中立工具（作品、统计、在播），P42 登记与撤销，N06 只剩技能可见性与提示词里的叫法、等 3b-35；⑦ 棘轮：uid 棘轮 `packages/ai/src/tools.ts` 删行，B 站替身 `packages/ai` 两行删，入口咽喉 `routes/ai.ts`、`stats/roast-generate.ts` 删行、`runtime/engines.ts` 8 → 6，写死中文白名单四份。交给 3b-35：内置技能里其余 B 站写法、B 站版周报以 `AiToolProvider.skills` 提供 | 3b-33、3b-24 | 否 | 中 |
| 3b-60 ✅ | 撤掉 `ai/trace-labels.ts` 的读时补标签（主人 10-16 定，3b-53 的缝），连同 `routes/__tests__/ai-chat-trace-labels.test.ts`。🔗 落成（10-17）：读会话原样交盘上的痕迹；认不出的工具名本来就补不出标签，行为不变；聊天路由的测试夹具改成工具环真实发出的形状（start 事件自带 `label` / `argText`），另钉一条「认不出的工具名落盘不带标签」 | 3b-53 | 否 | 小 |
| 3b-35 ✅ | 内置技能改名（留别名）、`allowedTools` 约束、提示词里的叫法；「AI 工具与技能约束」守卫同片开。来源描述的 `creatorNoun` 与 contract 里的叫法函数这一期造（主人 10-14 定提前），提示词按 ADR-0030 决策 3 全做；技能里写了查不到的工具名记一条 warn。0.x 的女仆技能不迁（见 3b-53），不再有技能文件的迁移改写。🔗 10-24 落成：① contract 的 `sourceNounsOf` 与 `SourceDescriptor.creatorNoun` 落地，中性词按读者分开（字典 `nouns.*` / `PROMPT_NEUTRAL_NOUNS`）；人格、核心工具说明、锐评、两个工坊、内置技能与 `BUILTIN_AI_PRESETS` 按涉及的来源填叫法，风格性写法改中性；② `AiToolProvider.skills` 与 `maid-skills/reader.ts` 读口落地（列表、`load_skill` 目录、斜杠点名共用；内置 / 提供方技能缺工具隐藏，主人技能照列只记 warn），提供方技能按 `<技能命名空间>-<本名>` 命名，B 站版周报为 `bilibili-weekly-report`；③ 六条内置技能改用核心中立工具，`find-creator` / `creator-pk` 改名并保留 `find-up` / `up-pk` 别名；④ 「AI 工具与技能约束」守卫开张即绿、无棘轮，对拍新增 P43 / P44，N06 转完；⑤ 内置人格默认文案带叫法变量，零代迁移修订号抬到 50。交给 3b-12：内置人格的最终默认文案已定（带叫法变量），开发期旧数据里存的是改前的文案 | 3b-34；题：内置技能的 `description` 翻不翻、「缺工具就隐藏」管不管主人自己的技能（开片时问） | 否 | 中 |
| 3b-36 ✅ | AI 写正文按目标选（ADR-0032），作品那一份：设置键、推送层逐目标挑正文、历史行存各目标实际收到的正文。计划原写 3a 做、3a 没有排进片表，主人 10-13 定进 3b。🔗 10-13：第一步已落 —— 设置键 `ai.writing { post, liveSummary }`（各一份 `{ enabled, byTarget }`，默认两份都开、没有例外，老设置与老备份靠默认补，不用抬迁移修订号），与两个折叠函数 `aiWritingFor`、`aiWritingNeeded`；余下几步的题 10-13 答完：推送层自己现取设置推导某个目标用哪一份正文（ADR-0032 决策 2），锚点上 AI 版那一串叫 `aiMessages`、推送路由上的读口叫 `aiWriting`。停着的工作区基线太旧，清掉另开新施工员从主干起。落成（10-16）：余下三步 —— 推送层逐目标挑模板版或 AI 版（本体看 `ai.writing.post`、总结附加项看 `ai.writing.liveSummary`，读口必填、每次现取；AI 版做不出来或为空就回落模板、不跳过锚点；无目标那行记默认那一份，静音与 @全体 各取各的）；装配恒做模板、有点评再按同一套版式做一份 AI 版，生成门折进 `postSettingsOf`（AI 总开关开着、且有现存目标用得上，指向已删目标的例外不算）；端到端钉住默认设置同今天、一个目标的例外只让它收到 AI 版、历史与人工重推各存各的那一份。看得见的变化：写了例外之后只有那些目标收到 AI 正文，没有目标用得上就不调 AI；点评回来是空的改用模板发（以前会推出一条只有链接的空文字）。直播总结那一份随 3b-37 | 无 | 开工时核 | 大 |
| 3b-37 ✅ | AI 写正文，直播总结那一份。🔗 10-16 落成：总结请求器同步交回模板与 AI 两份（没有 AI 版就不带 `ai`），直播锚点带可选的 `aiMessages`，推送层按 `ai.writing.liveSummary` 逐目标挑；生成门改成宿主现算的必填读口 `isAiEnabled`（AI 总开关开着、且默认开或有现存目标的例外开，每次下播现取），`LiveEngineConfig.aiEnabled` 删掉；「现存目标的 id」抽成 `engines.ts` 里作品与直播共用的一个局部函数。看得见的变化：默认关、没有用得上的例外时不再白问一次 AI；AI 回空串改用模板发（以前整条总结跳过）；默认设置下推出去的字不变 | 3b-36、3b-19 | 否 | 中 |
| 3b-53 ✅ | 0.x 的女仆技能与女仆对话不迁（主人 10-14 定）：迁移清单里这两项改成不带进新代，删掉会话迁移与聊天附件进图库那一步及其测试；AI 设置照迁；迁移报告里写一句。🔗 10-16 落成：迁移修订号 46，备份版本不抬（备份只装设置）；女仆技能、女仆对话、聊天附件留在第 0 代，报告里各记一条没带过来的；会话改写与附件进图库那一步连同两个迁移模块撤掉。首访页要不要也说一句，记进活尾巴 | 3b-16（排在动盘队列里） | 是 | 小 |
| **己 拓展契约第 3 版（一次定稿的对外接口）** | | | | |
| 3b-38 ✅ | 集成上下文加成员：`reportProblem` / `resolveProblem`、`signal`、`redact`（`settings` 挪到 3b-41 与并形一起上提，10-15 定：先提会让拓展适配器的 `start(ctx).settings` 与 `activate(ctx).settings` 同名不同形；这一片让拓展上下文直接继承集成上下文）；问题上报三层（集成 / 来源 / 适配器）签名同一个，都带 `notify?`、`recoveryMessage?` 与清时的 `notify?`；`Problem.about` 加连接那一支（问题表的键、`apps/contract` 的类型跟改，连接删了跟着清，宿主核连接归属）；新成员就地对拓展开；日志按值打码：各集成 `secrets`、cookie 罐一到就登记、`ctx.redact`，少于 8 个字符不遮，删掉写死 B 站 cookie 名的五条（打码点 10-15 已挪到日志调用的入口，按值登记接在那一处）；内置的先接上 = 内置集成拿到新成员、接好问题表，这一片不新增上报（QQ 网关连不上那条随 3b-52）；拓展的问题上报被拒先只打 warn（ADR-0025 决策 10 下 10-15 的 🔗，主人定），出入表随 3b-42 加宽；契约小号不抬（第 2 版还没发版，0.12 与桥 0.0.1 都是第 1 版） | 3b-03 | 否 | 中 |
| 3b-39 ✅ | 请求客户端与 `fetchImage` / `storeImage` 进公共上下文，B 站自己的上下文并进去；内置适配器改走它（出网点名表 12 处）；对拍 N12 与「看图从图库引用」。请求客户端加：websocket 发文本帧与读连接状态、给错地址回 `invalid` 不抛；请求体收 `FormData`；单次请求可选「不带浏览器身份、不碰罐」（内置适配器全用）；不开默认头的口；cookie 罐引 `tldts` 拒公共后缀（新运行时依赖，走装配自检）；抓图失败七个码；集成抓的图算「在途」 | 3b-38 | 否 | 大 |
| 3b-40 ✅ | 推送侧加宽（ADR-0024 决策 3、4）：第一个提交单做入站改名（私聊与群的 `userId` / `groupId` → `address`，群里说话人 `senderId`，`InboundSinks` → `InboundHandlers`；桥帧照旧、在桥的适配器里映射），别的线好变基；完整的连接候选（门导出造中性平台描述的函数，桥用它填）、候选读口挂在 `/api/adapters/:adapterKey/` 下、面板读的 `/api/ext/:id/bots` 同一个提交删掉；入站经适配器上下文；适配器自己的描述这一期不造（主人 10-13 定）；`registerAdapters` 改成一次性；3a 期末审查留下的另两处顺手修。🔗 10-16 落成：七步加一个小提交 —— 入站改名；内置适配器只登记一次；适配器视图不丢原型方法；中性平台描述；候选口必备、候选读口挂在适配器下、`/api/ext/:id/bots` 删掉；入站经适配器上下文（适配器只报连接 id，宿主核归属、平台取自连接，归属与问题上报共用一个判法，桥与宿主的「平台对不上」警告删掉）；派发器按 id 只读单条连接。主人 10-16 另定：适配器停下之后交来的入站丢掉并记一行，与上下文里别的口子一致。目标表仍整表读，要开按 id 取单条目标的新口，不在这一片 | 3b-03 | 否 | 大 |
| 3b-41 ✅ | `settings` 上提到集成上下文（10-15 从 3b-38 挪来）；两种设置读取口并成内置那一种（拓展的 `ctx.settings(规则)` 也交回 `SettingsReader<T>`，`ExtensionSettings<T>` 删掉，读不懂的拓展仍不起；没设过的拿空对象过规则，过不了回 `not_configured`、拓展照跑）；每个拿到上下文的集成都在配置仓登记一段；桥改一处读法；拓展「设置读不了」进问题表（`settings_invalid`、记在拓展名下、不私聊；启动失败那条路上别被「停下就清」清掉） | 3b-38 | 否 | 中 |
| 3b-42 ✅ | 拓展的上报换新形状（没有返回值；作品、直播、资料三种），拓展订阅源并进来源登记表，旧的翻译层删；`registerSource` 一族改名；来源 `health()` 的返回当外来数据收；清单 `contributes.subscription` 收 `externalIdNoun?`（10-23 主人定，宿主 3b-24 已认这一格）。主人 10-24 定的：`auth` 这一版不对拓展开；推送侧的周期「正在直播」计时与 `skipped` 出入这一片删（周期只由核心计时调 `fetchLiveStatus`）；统计「在记」拓展在册即在记（ADR-0027 决策 13 下 🔗）；拓展视频作品不再有宿主写的「投稿了视频」；新名字一批（见交付说明）。时刻照 architecture「明确不改的」留毫秒。落成（10-25）：① 核心 `SourceContext.reportProfile`（停用的不收、写完当场重算面板那几行、粉丝样本按刷新间隔稀释），资料收口 `createProfileReportHandler`，对拍 P47（P46 归 3b-12）；② 拓展包 `registerSource` / `SourceDef` / `SourceHandle` 与拓展这一侧的 `SourceContext`（核心那份去掉 `reportLiveInteraction` / `registerLinkResolver` / `registerAiToolProvider`）、毫秒版上报镜像；internal 第 3 版进门 zod `schema/extension-report.ts`；③ 外来数据只在 `extensions/extension-source.ts` 的 `createExtensionSource` 收：外部 id → 清单声明的种类 → 形状，毫秒 → ISO，图库引用读回补宽高与动图标记，每个来源一条串行队；登记异步、装载器等它落定、`start` 抛 = 加载失败；拓展来源的问题写者名取清单名；④ `health()` 收成单行、120 字截断、坏了「状态读不到」；清单收 `externalIdNoun`；面板搜人经引擎的 `searchCreators`（共用来源串行闸），候选 `CreatorCandidateView`；拓展三层问题上报被拒也进出入表（种类 `post` / `live` / `profile` / `problem`）；⑤ 假源搬到新口并实现 `fetchLiveStatus`；声明了周期直播没交 `fetchLiveStatus` 的拓展装不上；⑥ 老路删净：`registerSubscriptionSource`、`receiveReport`、总线事件 `subscription-reported`、`posts/extension-post.ts`、`posts/post-from-report.ts`、`live/extension-live.ts`、`stats/extension-source.ts`、`runtime/extension-push-common.ts`、第 2 版上报 schema 与镜像；`bindStatsRecorder` 退役不造；⑦ 棘轮：B 站替身 `index.ts` 一行清零；写死中文 `context.ts`、`live-push.ts`、`engines.ts`、`subscription-avatar.ts`、`extension-subscription.ts`、面板出入框几行降、两行删；平台词汇守卫照 `post.ts` 先例给 @某人片段的 `userId` 记两行。契约仍是第 2 版、只更新摘要。不动盘。真机没验 | 3b-22、3b-24、3b-39、3b-62 | 否 | 大 |
| 3b-43 ✅ | 多语言给拓展（ADR-0037 决策 14，主人 10-14 改）：译文放包里单独的目录、一种语言一个 `<语言码>.json`（目录名同 BN 自己的译文目录）；宿主读它们给上下文一个 `ctx.i18n`（按当前语言取字、语言变了自己换并给 `onChange`），顶替原排的「当前语言 + 变了的通知」两格；清单字段的译文住同一份文件的保留段；写坏的或对不上的键只丢那几条、不拒整个拓展；装包白名单、解压总量上限、打包脚本同改；市场索引这一期不分语言 | 3b-09、3b-38 | 否 | 中 |
| 3b-44 ✅ | 清单第 3 版的 schema、契约最低版本抬到 3、契约形状守卫换新；桥迁第 3 版并抬版本号（只进预发布档）；桥协议的失败统一成结果形状（协议升一个小版本：只加可选字段，旧回执照认）。拓展推送口改名与把手瘦身归这一片（`registerPushSource` / `PushSourceHandle` / `PushExtensionDef` 一组改成适配器一侧的叫法，桥改读 `ctx.connections()`）。**这几样同一批落**。落成（10-25）：推送口改成 `registerPlatformAdapter` / `PlatformAdapterDef` / `PlatformAdapterHandle`，把手只剩 `dispose()`，桥改从适配器上下文读连接；订阅与推送的 wire 视图摊平；清单升第 3 版、最低版本抬到 3，假源与桥清单迁形；`searchAccepts` 取代 `lookupPlaceholder`，清单收 `creatorNoun`、`icon`；桥协议升到 1.5，回执统一成结果形状、假桥也回结果；桥版本为 `0.1.0-alpha.1`，只进预发布档 | 3b-04、3b-40 至 3b-43 | 否（动线上格式，只加不改） | 大 |
| 3b-45 | 假桥与桥的开发场景搬进 `extensions/bridge/`（清单 `contributes.devtools`，开发入口不进发行包） | 3b-44 | 否 | 大 |
| 3b-46 | 守卫 21a（假源拓展升第 3 版逐项走）与推送守卫③（假适配器逐成员走）；契约文档定稿（只调 HTTP 接口的不用管连接名单、维持长连接的才对账并给样板；两层地址这一版只能手填） | 3b-44；题：假适配器是给假源加一口还是另起一个拓展 | 否 | 中 |
| 3b-51 ✅ | 问题文案中立化（主人 10-14 定）：集成写的问题句一律平实、只说事与平台这一侧自己会怎么做，不称呼主人、不自称女仆、不写宿主的界面；私聊时宿主按口吻把话说完整（「主人，刚刚 <名字> 报告：……」/「<名字> 报告：……」，名字取来源描述与拓展清单），恢复句同样补完整，宿主自己写的整句不加引子；引子与恢复句进字典（平实版 + 女仆层）。登录问题改由宿主看各来源的登录状态报与清（`expired` 进表并私聊、`logged-out` 只进表、`logged-in` 清），B 站不再报 `auth_lost`。B 站八条问题句改写、断言原句的测试跟改 | 3b-10、3b-38 | 否 | 中 |
| 3b-61 ✅ | 换语言时问题表重报（主人 10-20 定，从 3b-51 拆出，第 4 期写女仆层之前落；ADR-0037 决策 8）：宿主自己写的问题句交取字函数，问题表在语言或口吻变了时重跑；B 站与 QQ 官方机器人自己记着、换语言时重报；通知器把「只换了说法」当同一件事（记成「不再说」的不重发，「已恢复」用新说法）；拓展照契约自己在 `ctx.i18n.onChange` 里重报，宿主不替它重出 | 3b-51 | 否 | 中 |
| 3b-52 ✅ | 连接通断归宿主（主人 10-14 定）：宿主每分钟探一次每条启用的连接（今天 5 分钟），连续两次探不通算断；运行中断了才私聊，主人的私聊目标走的就是这条连接时不发；探通了清并只对私聊过的补「已恢复」；记在连接所属适配器名下；探测结果状态变了才写盘；OneBot 小程序卡能力的重探节奏与「探不出来不推翻已探实的」收到宿主。开工先核每分钟探一次 QQ 官方的接口有没有频率限制 | 3b-38、3b-40；探测那一段在 `runtime/engines.ts` 里，与线一按先后排（或先把它搬出 `engines.ts`） | 否 | 中 |
| 3b-54 ✅ | AI 工具标签合成一格（主人 10-14 定，3b-32 的缝）：`labelArgs` + `formatLabelArg` → `labelArg?: { keys, format? }`（小条只补一格；`keys` 是按顺序取第一个有值的候选参数名，`format` 只翻那一格的值）；核心那几把仍是文案表里的格接上参数定义的必填格。不上盘、不进契约。同一提交批里命名规范的词表加一行「引擎」（主人 10-14 定）：`Engine` 指长期运行、按自己的时钟推进的部件，宿主直播一侧只有场次引擎一个，来源内部的拉取部件按自己的职责起名。10-15 主人定同批改两个名字，让规矩落地当天对齐：B 站来源里的 `DynamicEngine` → `DynamicPoller`（先例 `FansPoller`；`DynamicEngineConfig` / `DynamicEngineOptions` / `DynamicEngineLike` 跟着改），卡片工坊编辑器调 AI 的那个小接口 `CardCssAiEngine` 按职责改（或直接写成 `Pick<CommentaryGenerator, "generateRaw">`、不另起名）；B 站的 `LiveEngine` 随 3b-22 拆掉；装配文件 `runtime/engines.ts` 一族（`createEngines`、`EnginesRuntime`……）随 3b-57 拆分时改名。落成（10-16）：标签那一格是 `labelArg?: { keys, format? }`（`AiToolLabelFields` 出口）；词表加「引擎」一行，例子只留 `Poller`；`DynamicEngine` 一族改名 `DynamicPoller`（文件 `dynamic-poller.ts`），`CardCssAiEngine` 直接写成 `Pick<CommentaryGenerator, "generateRaw">`；开发工具与测试样本里没人再发的来源 id `dynamic-engine` 换成真实的 `post-delivery` | 无；排在 3b-33 之前（两片都动核心工具的标签文案表与标签测试） | 否 | 小 |
| 3b-55 ✅ | 卡片那几格收拾（主人 10-14 定，3b-17、3b-19、3b-20 的缝）：撤掉内存里的 `CustomCardStyleLike`（盘上 ㉔e 已收成 `cards { enabled, liveCoverImageIds }`，它没跟上，`font` / `fontAsset` 两格没人写）；皮肤两格一律引用 `CardSkinChoice`；醒目留言与会员的入口不再收卡样式，只有直播的入口带一格封面；下播回顾与总结请求器的 `fanClubName` 改成可选、没有就缺键（提示词里不写那一行，模板出字不变）；`live/` 里拓展直播那几个文件的局部变量 `row` / `rows` 改 `entry` / `entries`。只动服务端内存里的类型与测试，不动盘与面板 | 3b-56 | 否 | 中 |
| 3b-56 ✅ | 会员发真图（主人 10-14 定，3b-18 的缝；修独立端从 0.12 起就有的 bug）：自定义上舰文案与兜底两支今天把图的网址交给内容构造口，翻成链接段，OneBot 与 QQ 官方都发成一串网址。改成先取图再发图段：兜底的徽章走 `fetchTierIcon`，自定义图由宿主给取图口；`send` 收中立的消息段（同醒目留言），撤掉 `content` 与收 `unknown` 的 `send`；取不到图只发文字、记一条警告；自定义图照全仓的取图口只连公网、只收 png / jpg / webp / gif 与 8 MiB 以内，不为这里开内网例外（10-15 主人定）。先写复现的红测，把「网址翻成链接」当正确行为钉住的那条守卫跟改。内容构造口整个撤不撤留到 B 站直播并进来源（3b-22） | 3b-16 | 否 | 小 |
| 3b-59 ✅ | 清掉单卡字体那条死链（主人 10-16 定，3b-56 的缝）。范围是渲染器的 `CardColorOptions.font` / `fontAsset`、`resolveFont` 里读每次调用传入字体的那两行、`posts/card-style.ts` 整个文件、装配里写死的 `{ enable: false }` 与 `linkCardPresentation().colors`，以及对应的测试。 | 3b-55 | 否 | 小 |
| **庚 收口** | | | | |
| 3b-47 | 登录装配进 B 站集成的 `start`；核心里 `api` 句柄的读者清到只剩第 4 期那几处（卡片真实预览、旧搜人）；B 站动态与直播两个引擎听登录改走 `deps.auth.onChange`，删掉 `BiliSourceDeps.bus`（今天两者经 `deps.bus` 听 `auth-lost` / `auth-restored`，不合 [集成副作用只经 ctx](../agents/conventions/integration-side-effects.md)；3b-22 留下的，主人 10-21 定排这一片） | 丙、丁、戊全部 | 否 | 大 |
| 3b-57 | 装配文件 `runtime/engines.ts` 照 [architecture.md](./architecture.md)「`runtime/` 只留 service-context、message-bus 与装配」拆成三份，`createEngines`、`EnginesRuntime`、`attachEngines`、`runtimeEngines`、`emitEngineError` 这一族按职责改名（主人 10-15 定开这一片：词表里「引擎」只指宿主里按自己的时钟推进的部件，这个文件装的已经不是引擎）；架构文档里「引擎编排」的说法跟改。开工前先勘察剩下的装配怎么分三份，分法拿给主人看 | 3b-22、3b-47 | 否 | 中 |
| 3b-48 ✅ | 更新后弹「本次更新」的服务端与打包脚本（ADR-0005 决策 16 下的 🔗；面板第 4 期） | 3b-09 | 否 | 中 |
| 3b-49 | 核心包 `packages/internal` 出口整理：按领域分子路径、把 `constants.ts` 按领域拆散、加一条守卫防止再长回去。**独占工作区**；开工前先勘察，分法拿给主人定。主人 10-13 定排在各线合回之后 | 3b-01 至 3b-48 | 否 | 大 |
| 3b-50 | 收尾：13 行与另补三项逐行核都转成了对拍；六道棘轮核数；清零期字面那几格问主人；全量门禁；加「集成自造客户端」守卫（主人 10-16 定，3b-39 的题）：集成目录（`bilibili/`、`platforms/`、`extensions/*/src`）里出现 `new HttpClient(` 或 `new CookieJar(` 就红，宿主的共用工厂放行，上限零 | 以上全部 | 否 | 小 |

### 同时开的四条线

- **线一 直播 → 资料 → 关注 → 统计**（3b-58 → 3b-16 → 3b-56 → 3b-55 → 3b-18 → 3b-21 → 3b-22 → 3b-23 → 3b-24 → 3b-25 → 3b-26）：都要动 `runtime/engines.ts`，线内一个接一个。
- **线二 拓展契约**（3b-04；3b-38 → 3b-39、3b-40、3b-41 → 3b-51、3b-52 → 等线一的 3b-22、3b-24 → 3b-62 → 3b-42 → 3b-43 → 3b-44 → 3b-45 → 3b-46）。
- **线三 链接预览、指令、AI**（门改名，连同 `extractUrlCandidates` → `extractUrls` → 3b-29、3b-31；3b-40 的入站改名 → 3b-30；3b-54 → 3b-33 → 3b-34 → 3b-35；3b-36 → 3b-37）。
- **线四 多语言地基**（3b-09 → 3b-08、3b-10 → 3b-11；3b-12 等动盘队列）。3b-51 要等 3b-10 的字典与口吻设置。
- 甲组的小片随时插。

只能一个接一个的：

- **迁移修订号与备份版本**。要动盘的片按这个次序排队：3b-16（特别关注名单与两把键）→ 3b-53（0.x 的 AI 数据不迁）→ 3b-21（直播文案）→ 3b-29（链接预览设置）→ 3b-31（重推原件）→ 3b-12（改存法，最后）。相邻两片能并成一次迁移的，开工时并。
- **`runtime/engines.ts`、`index.ts`、`compose.ts`**：线一独占 `engines.ts`；别的线只在这三个文件里加减几行接线，合回时按先后变基。3b-52 的探测那一段也在这个文件里，排进线一的先后。
- **对拍文件里 `PARITY_ROWS` 的行数断言**：各片各转各的行，合回时串行。
- **棘轮表**：每片只调自己清掉的那几行；最后一个文件清掉时由那一片删整行。

### 开工前定的（10-13，主人定）

- **核心包出口整理排在 3b 最后**（3b-49），不排最前。理由与当初否掉「3a 中途插队做」相同：后面的片都要在新分法上重改，而 3b 还要往这个包里加来源接口的新成员、契约第 3 版的类型与多语言的字典层，类型没有落定。期间继续守「不往 `constants.ts` 里加新东西」，面板要用的新小函数各开自己的零依赖子路径。被否：排最前（要先勘察、定分法，这期间别的线都开不了工）。
- **「AI 写正文按目标选」作品与直播两份都在 3b 做**（3b-36、3b-37）。作品那一份计划原写 3a、3a 没有排进片表。使用者有名有期（第 4 期 AI 设置页「女仆写正文」一节）、形状 ADR-0032 已写定，照「预知的使用者算数」提前造；推送层「逐目标挑正文」这个维度两份共用。被否：两份都挪第 4 期；只做直播那一份。
- **原先没有归期的几件的去处**：全局时区进 3b（3b-11）；剩下的一批设置改名（排行榜推送、静音时间、免扰时段、词云停用词、登录检查间隔、AI 全部子键等）挪到第 4 期，和「核心设置加 `core.` 前缀、面板改保存路径」并成一次；订阅坏行隔离挪到第 4 期，和问题框、「设置不合法」那两种状态一起设计；「投递失败归核心」（ADR-0024 决策 15）先不进表，3b 开工后量清楚还差什么再定。

### 开工前定的（10-13 晚至 10-14，主人定）

各片的题在这两天逐道问完，定案已写进相关 ADR 的 🔗 与 `docs/1.0`、`docs/agents` 的活文档：契约第 3 版一组（ADR-0025、ADR-0024）、问题上报与问题文案（ADR-0025 决策 11、ADR-0037 决策 15）、连接通断归宿主、特别关注名单（ADR-0021 决策 17、ADR-0027 决策 1）、直播兜底（ADR-0021 决策 27）、链接预览（ADR-0029）、多语言给拓展（ADR-0037 决策 14）、市场（ADR-0013）、0.x 的 AI 数据不迁（ADR-0022）。片表照它们重排，见上表各行。

### 开工后主会话照已有定案直接定的（10-13；主人可否决）

各条方案里提的题，凡是总计划、定案或主人说过的取向已经指向一个答案的，主会话直接定了，不再逐道问：

| 题 | 定的 | 依据 |
| --- | --- | --- |
| 链接解析器与 AI 工具提供方从哪登记 | 登记方法加在来源上下文上，B 站在自己的 `start(ctx)` 里登；组装根不直接认领 | 总计划「集成级登记的终点」写的就是在 `start(ctx)` 里登；今天只有来源一个使用者，放最窄的地方 |
| 链接预览的冷却在联网之前怎么记账 | 两把键：先按链接原文记，解析成功后再按 `canonicalId` 记 | 今天短链就是这么做的；坏链接照旧吃冷却 |
| webhook 线上的小程序卡字段名 | 不变，适配器里映射 | 3a-04 冻住了线上格式 |
| 没有 `https://` 的裸链接 | 照旧认 | 不认是功能倒退 |
| AI 工具的标签怎么到面板 | 痕迹自带标签，落盘时一起存 | ADR-0037 决策 8：存下来的话不跟着语言变 |
| 契约第 3 版的改动 | 逐片就地改，不留新旧并存到 3b-44 的过渡。代价：3b-40 到 3b-44 之间，开发机的数据目录里若装着已发布的桥 0.0.1，它会在运行期报错，而清单仍显示装得了 | 主人的取向：开发期不留过渡；dev 在第一版 alpha 前不推 |
| 请求客户端进公共上下文时包之间成环 | 接口类型住核心包、实现留在 `packages/http` | 实现包本来就依赖核心包 |
| 检测循环的并发 | 按创作者分组、组间并行，上限 4 | 见 3b-01 |
| 英文与日文的译文在第 5 期之前可以不齐 | 缺的句子合成字典时拿简中打底；「各语言的键必须齐」的检查第 5 期翻完再打开 | ADR-0037 决策 16 把翻译排在第 5 期 |
| 直播装配抽进 `live/` 时，「确定要出卡才取」的两处网络调用（观众头像、档位图标）怎么过核心的入口 | 入口多收一个「要用时再取」的函数，确定要出卡才调 | 这几片是保行为的搬家；被门槛拦掉的也去打平台接口是风控面。来源接口上的 `liveInteractions` 长什么样留到 3b-22 问 |
| 兜底文字里平台自己的叫法（「SC」「元」「大航海」）搬进核心后怎么写 | 由 B 站那边把这句话拼好、作为参数交进入口，字不变 | 中立性规范；推出去的字不变 |
| 会员的推送过不过串行闸 | 保持不过，把说它「也过闸」的那句旧注释改对 | 保行为 |
| 链接预览那扇门的名字没定时，重写本体做不做 | 先做，门沿用今天的名字（`LinkParser`、`link-parser.ts`），名字定了再单做一个机械的改名提交 | 名字不影响行为；等名字会让 3b-28 到 3b-31 整条线空等。名字 10-13 定为 `LinkPreviewer` |
| 场次引擎搬家（3b-20）动不动两条总线事件、对不对齐字段 | 都不动 | 片表把事件改名与多收的字段放在 3b-23 |
| 同一个东西换了写法（3b-28）：规范 id 取什么、同一条消息里贴两种写法 | B 站的规范 id 取接口回的 BV 号（av 链接与 BV 链接落到同一个）；同一条消息里按「解析器 + 规范 id」再去一次重，冷却关着也只出一张 | 定案的冷却键就是「群 + 解析器 + 规范 id」；旧代码在一条消息内也是按视频去重的 |
| 原生分享描述里的 `appId`（3b-28） | 先用来源的键占位；10-14 定：填 B 站 QQ 小程序真实的 appid，见 3b-31 | 定案只给了这一格的名字 |
| AI 工具预期内的失败（3b-32）：抛错还是返回失败、码怎么挑 | 一律返回失败，码照标准码表；卡种给错算 `invalid`、每轮的限额算 `rate_limited`；话不变，喂回模型时不再带工具环给抛错加的前缀 | 失败规矩第 1、2 条：可预期的失败回结果，抛错只留给 bug |
| 老会话里没有标签的工具痕迹（3b-32） | 服务端在读会话的回应里现补，不改写盘上的文件；以后工具改名、撤走时老痕迹怎么办随 3b-35 那道题一起定 | 不为这一片动盘；升级上来的老会话不该退成一串英文标识符。10-14：0.x 的会话不再迁进 1.0（3b-53），这件事不用再定。10-17：读时现补已撤（3b-60） |
| 面板的模板变量提示（3b-21） | 与模板变量表同片改成读那张表 | 只留一份 |
| 3b-21 的迁移认哪几代旧默认文案 | 开工时去各发布标签上查这三条默认的原文，查到几代认几代 | 依赖旧版行为的先去发布标签上读代码 |

这一天有几处**新开的缝没有先问**，名字照命名规范的后缀表、词表与同目录的先例推出来，施工已经开了，主人不同意就改回去（改名是机械活）。10-14 晚主人逐处过完，结论在表下：

| 缝 | 名字与形状 | 依据 |
| --- | --- | --- |
| 3b-15 的两个入口 | 文件 `live/special-users.ts`；`pushSpecialDanmaku(options, deps)`、`pushSpecialUserEnter(options, deps)`；参数包 `SpecialDanmakuOptions`、`SpecialUserEnterOptions`（`viewer { id, name }`、弹幕多一格 `text`、`settings` 用已有的两个设置形状、`creatorName`）；协作者 `SpecialUserDeps { send(text) }` | 同目录 `pushLiveNotify(…, deps)` 的先例；后缀 `Options`、`Deps`；词 `viewer`、`creator`、`name` |
| 3b-17 的入口 | 文件 `live/superchat.ts`；`pushSuperchat(options, deps)`；`SuperchatOptions`（`event`、`minAmount`、`creator { name, avatar? }`、卡样式与皮肤三格、`fallbackText`）；`SuperchatDeps`（`renderer`、`fetchViewerAvatar`、`send(段)`、`logger`） | 同上一行的路数；发送收的是核心包现成的消息段类型 |
| 3b-18 的入口 | 文件 `live/membership.ts`；`pushMembership(options, deps)`；`MembershipOptions`（`event`、这一档的展示信息 `tier`、`minRank`、生效的文案包 `template`、`creator`、卡样式与皮肤三格、`fallbackText`）；`MembershipDeps`（`renderer`、`fetchTierIcon`、`fetchViewerAvatar`、内容构造口 `content`、`send(消息)`、`logger`） | 同 3b-15、3b-17 的路数；有两支要发「按网址取的图加一句文字」拼成的一条消息，现成的消息段类型装不下，所以这一个用核心 `live/` 里本来就有的内容构造口 |
| 3b-19 的家与入口 | 目录 `live/recap/`；`recapAnchors(options, deps)`、`RecapOptions`、`RecapDeps` | 词表：下播后的回顾叫 `recap` |
| 3b-28 的通用网址挑选 | 文件 `link-preview/extract-urls.ts` 的 `extractUrls(text)` | 从今天 B 站那条正则的写法推广；只管形状，认不认归解析器 |
| 3b-20 的名字 | `ExtensionLiveSessions` → `LiveSessionEngine`（文档管它叫「场次引擎」）；`ExtensionLiveRow` → `LiveTableEntry`（`Row` 不再用）；`ExtensionLiveTable` → `LiveTable`；`LiveCardFacts` → `LiveCardFields`；常量 → `LIVE_CHANGED_COALESCE_MS`；场次变化联合的判别键 `type` → `kind`；运行时上的 `extensionLive` → `liveTable`、`extensionLiveSession()` → `liveSession()`。线上名字（总线事件、契约类型、字段 `extensionId`）与日志前缀、端到端测试文件名都不动 | 后缀表；data-model 的改名表；仓里同类常量的写法 |
| 3b-32 工具上的标签格 | `AiTool`（原 `ExtraTool`）加 `label`、`labelArg`（小条上补哪一格入参：`keys` 是候选参数名，`format` 把那一格的值翻成给人看的样子；3b-54 由原来的两格合成一格）；痕迹的开始事件带 `label` 与 `argText` 并落盘 | 定案只写了「`label` 与参数标签」；面板那张表里有的三样都得由工具这边给，后两格的名字原是暂起的，3b-54 已改定 |
| 3b-27 链接半 | 类型 `LinkResolver`、`LinkPreview`（文档原文）；`createLinkResolverRegistry()` 与 `LinkResolverRegistry { register, entries }`（读口带键）；来源上下文上的 `registerLinkResolver(resolver): Disposable`；运行时上挂 `linkResolvers` | 类型逐字照 data-model 与 subscription-sources；登记表照来源登记表的写法；登记口照契约里 `register…` 一族 |

10-14 晚主人逐处定的：

- **3b-15**：随 3b-16 改名 —— 文件 `live/special-viewers.ts`，`pushViewerChat` / `pushViewerEnter`，`ViewerChatOptions` / `ViewerEnterOptions`，共用 `SpecialViewerDeps { send(text) }`；`creatorName` 改成 `creator: { name }`，与醒目留言、会员同一种写法。四个入口都是「`push` + 特性键」。
- **3b-17**：收下。卡样式与皮肤三格不包成一格：盘上的卡片设置 ㉔e 已经只剩出图总开关与直播封面，渲染器与盘上的皮肤两格都是平铺；撤掉内存里没跟上的 `CustomCardStyleLike`、皮肤两格引用 `CardSkinChoice`、只有直播入口带封面（3b-55）。
- **3b-18**：上面「现成的消息段类型装不下按网址取的图」那条理由不成立 —— 网址经内容构造口翻成链接段，图从没以图发出去过。会员改成先取图再发消息段，撤掉 `content` 与收 `unknown` 的 `send`（3b-56）。
- **3b-19**：收下；`fanClubName` 改成可选、没有就缺键，对齐 data-model（3b-55）。
- **3b-28**：`extractUrlCandidates` → `extractUrls`，文件 `link-preview/extract-urls.ts`。词表里的 `Candidate` 只指「供人挑选」的候选，这里的是交给解析器问的，不另起第二个意思；并进门改名那个提交。
- **3b-20**：收下。「引擎」在命名规范的词表里补一行定义（3b-54）。
- **3b-32**：两格合成一格 `labelArg?: { keys, format? }`（3b-54）。
- **3b-27**：收下。

10-16 第一批施工里又有七处新开的缝没有先问（方案里标了「只标、不定」，名字照命名规范的后缀表推出来就派了），10-16 主人逐处过完、全部收下：

| 片 | 缝 |
| --- | --- |
| 3b-58 | `subscriptions/external-id.ts` 的 `externalIdRefusal`：外部 id 照来源描述符声明的 `externalIdRegex` 核，只在这一处 |
| 3b-38 | `problems/problem-report.ts` 的 `ProblemReport` / `problemReportIssue`：集成、来源、适配器三层上报共用的形状检查 |
| 3b-38 | `logs/value-redactor.ts` 的 `createValueRedactor`：按值打码的登记册，运行时只建一个，日志出口、集成存储、B 站 cookie 罐共用 |
| 3b-33 | 读口 `CreatorReader`（女仆工具读订阅的中立口子），生成器上 `setCreatorReader` 取代 `setSubscriptionsSource` |
| 3b-33 | `packages/ai/src/creator.ts` 的 `creatorOf` / `parseCreator`：`creator`（「来源键:外部 id」）的拼与拆，按第一个冒号切 |
| 3b-33 | `subscriptions/platform-label.ts` 的 `platformLabelOf` / `PlatformLabelDeps`：平台名的唯一取法，锐评与女仆的订阅视图共用 |
| 3b-40 | `push/adapter-members.ts` 的 `pickAdapterMembers`：成员表 `satisfies` 适配器接口，视图、派生表、拓展包装、能力注入四处都按它取成员，方法 `bind` 回原实例 |

另有三件**超出了已有的定案**（把第 4 期的东西提前，或要在定案下补一句），10-13 先这么排了，**10-14 主人逐件过目都选了照这样做**：

| 件 | 先这么排的 | 为什么不照原样 |
| --- | --- | --- |
| 来源的 `searchCreators` | 这一期造、B 站实现，给 AI 的搜人工具用；对应的路由与面板仍在第 4 期。总计划「以后再说」原写第 4 期 | 对拍 N06 要六把中立工具齐，搜人那一把没有它就出不来；不提前的话 N06 这一行 3b 转不了 |
| 来源描述上的 `creatorNoun` | 这一期加，提示词里的叫法这一期全做。文档原排在第 4 期面板改造 | 对拍 N06 点名了「提示词里的叫法」 |
| 链接预览的 `cooldownSeconds` | 留着，叫 `cooldownSec`；另外主人 10-14 定加回总开关，`linkPreview` 是五格（见 3b-29）。ADR-0029 定的是三格、ADR-0032 说两处同一形状 | 这一格今天主人调得了，三格的形状里没有它的位置；丢掉就是少一个设置 |

### 原先没人认领的，各自的去处

开片勘察查出、文档里有方向但没有片认领的几件，主会话照已有的定案排了去处：

| 件 | 去处 | 依据 |
| --- | --- | --- |
| `colorFromUid` 改名 | 3b-07 | data-model 改名批 |
| 日志出口里写死的 cookie 名、`ctx.redact` | 3b-38 | ADR-0025 决策 9 |
| 在播快照里的 `uid` / `roomId` | 3b-23 同片改 | 事件去 `uid` 本来就要动面板那两处读者 |
| 入站形状的 `userId` / `groupId` | 3b-40 | data-model 改名批（改成地址，桥帧照旧） |
| 特别关注名单的 `uid` | 3b-16 | data-model 定的公共形状；对拍 N10 在 3b 的 13 行里 |
| 风控码全仓统一 | B 站一张翻译表，3b-18 建表并改拉动态、直播、续期那几处，3b-24 改粉丝轮询那几处，不单开片（主人 10-14 定的码表见 3b-18） | construction-plan「以后再说」 |
| 会员档 key 的命名空间、「来源声明的图」 | 3b-22 | 同上 |
| 直播引擎里那一处 `engine-error` 事件的去处、`PickLiveCover` 重复的一份、`MasterInfo.userface` 只写不读 | 3b-22 顺手 | 3a 各片「留着的」 |
| 3a 期末审查留下的三处（适配器视图用对象展开造、`registerAdapters` 失败后的复位、发送时重解连接设置） | 3b-40 顺手 | 都在推送一带 |
| 问题文案中立化、登录问题归宿主 | 3b-51 | 主人 10-14 定 |
| 连接通断归宿主、OneBot 能力重探归宿主 | 3b-52 | 主人 10-14 定 |

### 开片时查实的

- **检测循环「逐条等抓图」不是 3a 才有的串行**。3a 把引擎改成只生产之前，循环里等的是整个投递（出卡、AI、发送）；之后等的是翻译加抓图。3a 新带来的是「抓图挪到了入队之前」。3a 的记录里把它叫作 3a 带进来的回归，不准；它仍然该修，排在 3b-01。
- **连接设置的校验已经做完**（3a-22-2）：保存时按适配器的规则校验、不过就拒，开机读到坏的只隔离那一条。总计划「还没归期的」里那一行已随这份文件改掉。
- **抬契约最低版本会让已经发布的桥 0.0.1（契约第 2 版）变成装不上**，所以市场索引放宽（3b-04）排在它前面，桥迁新版与抬版本同一批落（3b-44）。
- **B 站的直播引擎没有任何 e2e**，只有单元测试；替拓展跑的那一套有。所以合两套之前先补钉子（3b-13）。

## 施工记录

### 3b-13 已落（10-13）

刻画测试：钉的是今天的样子，不等于今天的样子都对。施工员逐组把实现改坏验过红（38 处），主会话另抽查了两处，结果一致。

- **够不到的**（这批测试不覆盖）：入口与组装根的接线、历史落行与主人私聊、房号解析、重连梯子与静默看门狗、开机补报、词云、AI 总结那一支（只测了模板兜底）、封面轮换、免扰与静音、开播准备期间到达下播帧的那几个窗口。
- **两处钉不住的**：取房间信息抛错时的上报与停监听有两处在做、互相兜着，只删一处测试不红；认不出的上舰档位「静默丢弃而不是抛」靠的是开头那道早退，没有用例直接钉。
- **今天的行为里看着像毛病的**（只记事实，没有修；3b-22 合引擎时逐条定）：
  1. 漏收下播的兜底只挂在周期「正在直播」那一拍上，周期推送关着的订阅漏了下播帧就一直停在「在播」。
  2. 周期那一拍取不到房间信息会停监听，但不翻成下播、不发事件，面板停在「在播」，接口恢复后也不回来（定案要改成跳过并记问题）。
  3. 取房间信息抛错时「停止监听」报了两次、停了两次。
  4. 开播那一支不看开播开关，关着也照样抓封面、出卡，交到推送层才被扔掉；下播、醒目留言、上舰那几支是看的。
  5. 兜底下播的时长算到「核对的那一刻」，不是真实下播的时刻。
  6. 周期计时从开播卡发完那一刻起算，定案（ADR-0021 决策 27）写的是按开播时刻起算。
  7. 特别弹幕与特别进场：要不要监听只看名单里有没有人，不看那两把特性开关。
  8. （3b-17 抽装配时查出，已随那一片改掉）醒目留言发图那一次抛了，会被当成出卡失败、再补发一句文字；会员那一支同理，随 3b-18 改。
- **后面几片要跟着改这批测试的地方**：3b-21 改占位符写法时夹具里的文案；3b-22 直播并进来源后夹具搭世界的办法；3b-23 事件改名后监听的名单与期望；3b-22 动会员档位表时上舰卡输入里的几个字面量。

### 3b-04 做完没有合回，等一道题（10-13）

施工员照片表做完了（核心包的索引校验与发版脚本都放宽成「同一个 id、同一档、同一个契约版本只留最新一条」，服务端选版先在这台 BN 装得了的条目里取最高），片级门禁全绿。主会话审的时候对着已发布的 0.12.0 核了一遍，查出片表与 [extension-contract.md](./extension-contract.md) 的前提有一处不成立，所以**没有合回主干**，改动留在它的工作区里：

- 0.12.0 的索引校验是旧规矩：同一个 id 在同一档里出现两条，**整份官方索引拒收**，市场页只剩一句「官方索引不合规矩」。
- 0.12.0 的选版不看装不装得了，只在自己渠道的候选里取版本最高的。
- 0.12.0 与今天的开发版读的是**同一个地址**上的同一份 `marketplace.json`。

所以「索引里旧契约与新契约的正式版各留一条，0.12 仍拿得到第 2 版的桥」对 0.12 不成立：那样的索引一发布，0.12 的官方市场整个不能用。放宽后的规矩只对带着新校验的 BN（这一期之后的版本）安全，也就是只对**以后**的契约升档有用。

1.0 的 alpha 期间不会撞上：第 3 版的桥只进预发布档，「一条正式（第 2 版）加一条预发布（第 3 版）」在旧规矩下本来就合法。会撞上的是第 3 版的桥第一次发**正式版**的那一天：照放宽后的发版脚本并索引，会并出两条正式版。

要主人定发版侧怎么办（给新版 BN 另开一份索引文件、旧文件保持旧形状；还是只留一份文件、到那天让第 3 版的正式版顶掉第 2 版，0.12 上桥那张卡变灰）。定了之后这一片按定下的做法改完再合。

10-14 主人定：给新版 BN 另开一份官方索引 —— 新的滚动 release `extensions` 上的 `marketplace.json`，旧 release 上那份留给 0.12、从此不动。这一片照这个改完再合回（见切片表 3b-04 那行）。

## 真机

不当硬门槛；3b 收口时主会话给一张十条以内的短清单。
