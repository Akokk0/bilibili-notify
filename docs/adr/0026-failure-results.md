# ADR-0026：失败规矩 —— 一次操作的结果与标准码

- **状态**：2026-09-28 `/grill-me` 拍板（一次一题）；09-29 施工前补决策 6；09-30 补决策 7。**未施工**。
- **记录方式**：拷问当场落的定案；拍板前先做了一次全仓只读勘察。标准码表的正本放在 `internal`，施工参考见 [docs/1.0/](../1.0/)。
- **影响面**：全仓的接口方法、HTTP 错误体、WS 控制帧、面板的错误提示、历史与重推里存的失败。
- **依赖**：[ADR-0023](0023-neutral-naming.md) 决策 10、11（错误码大小写、`ok` 与 `code` + `message`）。

## 背景

勘察查出全仓至少 12 种失败写法：HTTP 错误体有 19 种形状，有的装 `err`、有的装 `error` 加 `issues`、有的没有 `message`；接口方法有的回 `null`、有的抛错、有的把平台的数字码塞进 `code`。面板的错误提示只认其中几种，别的原因全被吞掉。顺带查出的现存毛病：AI 工具失败在面板上显示成功；搜人时的风控和未登录都报成 404；拿登录二维码失败却回 `ok: true`；指令出错不回话。

## 决策

1. **一次操作的结果一律是 `{ ok: true, … } | { ok: false, code, message, upstreamCode? }`，抛错只留给 bug**。宿主在边界接住抛出来的错，按 `unavailable` 处理并记错误日志；发送除外：发送抛了按 `indeterminate` 处理，因为抛之前可能已经发出去了，回 `unavailable` 会让调用方照「稍后可重试」再发一遍。上游平台自己的错误码放 `upstreamCode`，不占 `code`。
2. **管什么、不管什么**：
    - 管：来源、平台适配器、横切接口与 ctx 的方法，HTTP 业务失败与错误体，WS 控制帧，桥回执进门时的翻译。
    - 不管：事件原因（如下播的原因）、描述性字段、AI 产出的内容、能力三态。
    - 「能不能」的预检保留 `can`，原因用 `code` + `message`。
    - ADR-0023 决策 11 的「`reason` / `err` / `why` 不再出现」只管失败原因。
3. **标准码只有一张表**，住在 `internal`：

    | code | 意思 | 自动重试 |
    |---|---|---|
    | `not_found` | 要的东西不存在 | 否 |
    | `invalid` | 输入或形状不对 | 否 |
    | `unauthorized` | 没登录或凭据失效 | 否 |
    | `rate_limited` | 被限流或风控 | 稍后 |
    | `unavailable` | 对端或本地暂时不可用（等一会儿就好） | 稍后 |
    | `not_configured` | 要主人先去配好某样东西，等是等不好的（09-29 补，见决策 6） | 否 |
    | `timeout` | 超时 | 稍后 |
    | `unsupported` | 这个对端不支持这项操作 | 否 |
    | `conflict` | 与当前状态冲突（版本号对不上、重复） | 看场合 |
    | `indeterminate` | 结果不明，可能已经成功 | 绝不 |
    | `unknown` | 原因不明、只有原话 | 否 |

    - 自定义码算失败、不自动重试。
    - 问题码（问题表里的 code）另算，只要求 snake。
    - 应用内更新的 `reason` 是失败原因，从 kebab 改成 snake（修订 ADR-0023 决策 10 的适用范围）。
    - `unknown` 用于迁移来的旧记录，以及冻结格式翻译过来、说不清原因的失败（如桥的回执）。
      🔗 **决策 7**：桥协议的回执也改成结果形状，要翻成 `unknown` 的只剩只带 `err` 的旧写法。
      🔗 **2026-10-08（3a-15）**：加第三种情形 —— 对端明确回了失败、只给了适配器没有对照的码（OneBot 的 retcode、QQ 的错误码、webhook 对端的业务码），`code` 用 `unknown`、码放 `upstreamCode`。被否：`invalid`（是猜，决策 5 自己说猜错比原因不明更坏）；自定义码（多造一个词）。
4. **按这条规矩改的两个接口**：
    - `fetchProfile`：`not_found` 记成 `creator_not_found` 问题，其余当暂时失败；整轮要不要刹车由来源自己决定。
    - `searchCreators` 改成返回结果形状，失败不再靠抛。
    - 按决策 2 同样管到的：`fetchLiveStatus`（`LiveStatusResult` 改成 `{ ok: true, kind: "live" | "offline", … } | { ok: false, code, message }`）、`fetchPreview`、`SourceAuth.beginLogin` / `logout`。
    🔗 **2026-10-14**（3b，B 站的落法，主人定；资料刷新那条主会话照规矩定）：**B 站返回码的翻译表**。B 站在 `bilibili/` 里有一张共用的「数字码 → 标准码」表，请求层在接口回来时查一次，翻成 `fail(标准码, 原话, { upstreamCode })`：`-352`、`-412`、`-799`、`-509` → `rate_limited`；`-101` → `unauthorized`；`-403` 不进共用表，由用到它的接口自己判（也可能是真没权限，如受限直播间）；没对照的码 → `unknown`，原码进 `upstreamCode`，每个进程第一次撞上记一条 warn。各轮询把 `unknown` 当一时失败、下一轮照拉、只进表不私聊。cookie 续期只在 `unauthorized` 时登出，`unknown` 下一轮再试（死会话由普通请求撞 `-101` 时登出）。资料刷新搬进 B 站来源后，撞风控也进同一个风控层（路名 `profile`），只进表不私聊。B 站的 AI 工具失败码走这张表；统计总开关关着时 `get_creator_posts` / `get_creator_stats` 回 `not_configured`（照锐评的先例），注入的工具失败也按结果形状返回。
    🔗 **2026-10-24**（3b-63，主人定；不带 `upstreamCode` 那半句主会话照决策 1 定）：**HTTP 412 也算风控**。B 站整页拦下的 412 风控页在请求层抛风控错误、外层不再连发，回结果形状的方法翻成 `rate_limited`；412 是 HTTP 状态、不是平台的码，不进 `upstreamCode`，原话进 `message`。wbi 签名请求那一族另加熔断：持续撞风控就当场回 `rate_limited`、不出网，窗口逐级拉长，到期只放一个调用去试探；结果形状与风控层的上报都不变。细节见 subscription-sources「B 站返回码的翻译表」。
    🔗 **2026-10-17**（3b-18 落成，主人定）：翻译表接进请求层的实情 —— 拉动态、直播预检、上舰观众头像、cookie 续期读标准码；回应不是对象或没有数字 `code` 回 `unavailable`；cookie 续期只有 `unauthorized` 登出；直播预检里 `rate_limited` 走长尾重试、`-403` 与表外码仍当受限房；上舰观众头像撞限流后 5 分钟冷却、不进问题表。细节见 subscription-sources「B 站返回码的翻译表」。
5. **旧数据**：历史里存的旧失败转成 `{ code: "unknown", message: 原话 }`；连接的探测状态不迁移，开机重探。
6. **错误体与造结果的统一写法**（09-29，切片 ④ 勘察之后）：
    - HTTP 非 2xx 的错误体 `{ code, message }` 之外只许两格附加：`issues`（`{ path?, message }[]`，拓展设置那处多一个 `op?`）与 `upstreamCode`；要加别的先问主人。勘察时的 `scope`、`id`、`revision`、`usedBy`、`detail` 面板不读或只拿来拼句子，删掉；`referencedBy` 并进 `message`；只装一句话的 `errors: string[]` 改成 `message`，真正的原因清单改成 `issues`。
    - 造结果一律用 `internal` 的 `ok()` / `fail()`，不手写对象字面量。类型叫 `Result<T>`、`Failure`、`FailureCode`、`Issue`；HTTP 的错误体叫 `ErrorResponse`。路由经 `respondFailure` 回，状态码从 `code` 推；全局出错处理把抛出来的按 `unavailable` 回并记错误日志。
    - 面板把非 2xx 解析一次成 `ApiError { status, code, message, issues }`，界面只按 `code` 分支，不再按状态码换文案。
    - 理由：19 种形状里真离不开结构的只有逐格标红；其余附加字段不是没人读，就是把一句话拆成了几块。清单封闭，免得又长回 19 种。
    - 盘上存的失败字段（历史的投递结果、`targets.json` 的探测状态、更新的 `reason`）仍按决策 5，随改盘上形状的那一期改。
    - 标准码补一个 `not_configured`（十个变十一个）：勘察时「没配置 / 没启用 / 没就绪」混在 `unavailable` 里，可前者等多久都不会好、得主人去配，按「稍后重试」处理不对；卡片预览也要靠它分开「没配 Chrome」（显示一键检测）与「引擎没就绪」。先前考虑过开一个只给渲染器用的自定义码 `renderer_unavailable`，否了：它背后是个通用类别，登记进同一张表就只剩一个标签。HTTP 回 409。
7. **桥协议的失败也用结果形状**（09-30，主人：「这也是应该统一的」）：
    - `result` 帧（插件 → BN，一次发送的回执）成功照旧 `{ type, id, ok: true }`；失败改成 `{ type, id, ok: false, code, message, upstreamCode? }`，也就是 `{ type, id }` 套一个 `Result`，任何一条失败回执单独拿出来都是一个合法的 `Failure`。`code` 取标准码表，插件说不清原因就填 `unknown`；平台自己的码（OneBot 的 retcode 等）放 `upstreamCode`。不带 `issues`：一次发送没有逐条原因，BN 也没地方显示；真要用再按「加可选字段」补。
    - `error` 帧（BN → 插件，出错但不断连）补 `code`，成为 `{ type, code, message }`，与 HTTP 错误体、WS 控制帧同一类（不带 `ok`）。
    - 走桥帧改名那套三拍：BN 先新旧两种回执都认（协议升 minor，只加可选字段；只带 `err` 的旧回执进门翻成 `unknown`）；两个插件并进桥帧改名那一趟改发新写法，插件仍只发一次版，过渡期 `err` 与 `code` + `message` 一起带（BN 按 zod 默认丢掉认不得的格，新旧 BN 都不坏）；等用户都升上去，BN 不再认 `err`。
    - BN 那半放在 3b，随桥迁契约 v3 与假桥搬家一起做：到那时投递结果才有 `code` 接得住，桥拓展才拿得到失败的零件，假桥也只动一次。之前 devtools 假桥发的 `result` 帧留在「结果不手写」的棘轮里，3b 改成 `fail()` 展开造，不开白名单。
    - 理由：`err` 就是失败原因，按决策 1 本该是 `code` + `message`；当初把桥回执当冻结格式、在进门处翻译，是因为协议已有发出去的插件，而桥帧改名那一趟本来就要让插件发一次版，顺带改掉不多花一次发版。
    - 🔗 现状（3b-44，10-25）：BN 那半已落，插件那半随 alpha 之后的桥帧改名。

## 取代与修订的旧条款

| 旧条款 | 现在 | 本份 |
|---|---|---|
| ADR-0021 决策 7「`searchCreators` 的错误文案由来源给」 | 修订：返回结果形状 | 4 |
| ADR-0023 决策 10「错误码与问题码用 snake」 | 延伸：更新的 `reason` 也是失败原因，改 snake | 3 |
| ADR-0023 决策 11「`reason` / `err` / `why` 不再出现」 | 收窄：只管失败原因 | 2 |
| ADR-0023 决策 6「错误体统一成 `{ code, message }`」 | 延伸：可选 `issues`、`upstreamCode` 两格，清单封闭 | 6 |

## 明确不做

- **失败用 `null` 或抛错表示**：`null` 分不清「查无此人」与「暂时不可用」，抛错让调用方只能靠 `catch` 猜。
- **标准码按模块各定一套**：同一个「限流」在不同模块叫不同的码，重试逻辑就得写好几份。
- **旧失败记录按原话猜一个标准码**：猜错比「原因不明」更坏。

## 后果

- 每个返回失败的地方都要改形状，面板的错误提示按 `code` + `message` 读一处。
- 盘上的旧失败记录只剩原话，统计与重推按 `unknown` 处理。
