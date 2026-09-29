# 失败规矩

一次操作的结果怎么表示、失败带什么码、什么地方归它管。这是活规范，可以直接改，但加条、改条要主人拍板；为什么这样定见 [ADR-0026](../../adr/0026-failure-results.md)。

## 规矩

1. **结果只有一种形状**：成功回 `{ ok: true, … }`，可预期的失败回 `{ ok: false, code, message, upstreamCode? }`。`ok` 保留，它是布尔前缀规矩的例外。失败原因只用 `code` + `message`，不再出现 `reason` / `err` / `why`。

    ```ts
    // 对
    return fail("not_found", "查无此人");
    return ok({ profile });
    // 错
    return null;
    throw new Error("not found");
    return { ok: false, code: "not_found", message: "查无此人" }; // 手写字面量
    ```

    造结果一律用 `internal` 的 `ok()` / `fail()`，不手写对象字面量。类型：整个结果 `Result<T>`，失败那一支 `Failure`，码 `FailureCode`，逐条原因 `Issue`（`{ path?, message }`）。

2. **抛错只留给 bug。** 宿主在边界接住抛出来的错，按 `unavailable` 处理并记错误日志。调用方不该靠 `catch` 判断「查无此人」还是「暂时不可用」。

3. **`code` 只取 `internal` 里那一张标准码表**，不按模块各定一套：

    | code | 意思 | 自动重试 |
    | --- | --- | --- |
    | `not_found` | 要的东西不存在 | 否 |
    | `invalid` | 输入或形状不对 | 否 |
    | `unauthorized` | 没登录或凭据失效 | 否 |
    | `rate_limited` | 被限流或风控 | 稍后 |
    | `unavailable` | 对端或本地暂时不可用 | 稍后 |
    | `timeout` | 超时 | 稍后 |
    | `unsupported` | 这个对端不支持这项操作 | 否 |
    | `conflict` | 与当前状态冲突（版本号对不上、重复） | 看场合 |
    | `indeterminate` | 结果不明，可能已经成功 | 绝不 |
    | `unknown` | 原因不明、只有原话 | 否 |

4. **上游平台自己的错误码只放 `upstreamCode`，永远不占 `code`。** 平台的原始响应不直接转给面板，在来源那层翻成 BN 的形状。

    ```ts
    // 对
    return fail("rate_limited", "被风控了", { upstreamCode: -352 });
    // 错：平台的数字码塞进 code
    return { ok: false, code: -352, message: "被风控了" };
    ```

5. **自定义码算失败、不自动重试。** 它必须是 snake_case 字符串。

6. **`unknown` 只用在两处**：迁移来的旧记录，以及冻结格式翻译过来、说不清原因的失败（如桥的回执）。

7. **HTTP 非 2xx 的错误体是平铺的 `{ code, message }`**，可选附加只有两格：`issues`（逐条原因，`Issue[]`；拓展设置那处多一个 `op?`）与 `upstreamCode`。不嵌套成 `{ error: { code, message } }`，不用 `err`、`error` 代替 `code` + `message`；要加别的附加字段先问主人。路由一律经服务端的 `respondFailure(c, failure, status?)` 回，状态码从 `code` 推，类型叫 `ErrorResponse`；4xx 的错误体不带 `ok`。「做一件事、回报结果」的接口（测试推送、预览）照旧回 200，体是 `Result<T>`。面板把非 2xx 解析一次成 `ApiError`，错误提示只读 `code` + `message`，逐格标红读 `issues`，分情况只按 `code` 判。

8. **ctx 上「请求类」的调用回结果形状，不抛。** 例：`state` / `secrets` 的写与删、`fetchImage`、`storeImage`。超上限或写了保留前缀回 `invalid`，磁盘写失败回 `unavailable`，取图 404 回 `not_found`，超时回 `timeout`。「上报类」调用（`reportProblem`、`resolveProblem` 等）保持 `void`，被拒记进 `reportRejections`，不把结果回给来源。

9. **「能不能」的预检保留 `can`**，原因用 `code` + `message`。

10. **发给主人的 `notifyMaster` 也返回结果形状**：主人目标不是私聊时回 `invalid`。

11. **按这条规矩改过的接口**：`fetchProfile`、`searchCreators`、`fetchLiveStatus`、`fetchPreview`、`SourceAuth.beginLogin` / `logout`。其中 `fetchProfile` 的 `not_found` 记成 `creator_not_found` 问题，其余当暂时失败；`fetchLiveStatus` 的 `LiveStatusResult` 是 `{ ok: true, kind: "live" | "offline", … } | { ok: false, code, message }`。

12. **旧数据转成 `{ code: "unknown", message: 原话 }`**，不按原话猜一个标准码。猜错比「原因不明」更坏。

## 边界与例外

**管**：来源、平台适配器、横切接口与 ctx 的方法，HTTP 业务失败与错误体，WS 控制帧，桥回执进门时的翻译。

**不管**：事件原因（如下播的原因）、描述性字段、AI 产出的内容、能力三态。这些不是「一次操作失败了」。

容易混的几处：

- **失败码与问题码是两套。** 失败码（`code`）取标准码表；问题表里的 `code` 另算，不受码表约束，只要求 snake_case，如 `follow_failed`、`creator_not_found`、`renderer_unavailable`。
- **码是 snake，状态值是 kebab。** `settings-invalid`、`logged-out` 这类是状态或事件的取值，写 kebab；错误码与问题码写 snake。应用内更新的失败原因 `reason` 也是失败原因，从 kebab 改成 snake。
- **`reason` 的禁令只管失败原因。** 事件里描述「为什么下播」的字段不受它约束。

## 怎么钉住

- **守卫「错误体」**（[docs/1.0/architecture.md](../../1.0/architecture.md)「守卫」表，第 1 期切片 ④b）：记账式，仿守卫 2（`scripts/error-body-guard.mjs`）。测试进程里把全局 `Response` 换成 Proxy，按构造时的调用栈认出服务端代码造的非 2xx 回应，逐个对一遍 `ErrorResponse`（`code` 在码表里、`message` 非空、附加只有 `issues` / `upstreamCode`），不合的记账，每条测试收尾查账；现有的路由测试就是驱动。
- **守卫「结果不手写」**（同表，④b 以棘轮开、第 5 期末清零）：非测试代码里手写 `ok: true` / `ok: false` 的对象字面量就红，`ok()` / `fail()` 所在的文件除外；类型里的 `{ ok: true }` 不算。
- 「抛错只留给 bug」、问题码的写法，没有守卫，靠审查。

审查时逐条看：

- 新增的失败路径是不是回了结果形状，有没有 `return null` 或为了「查无此人」抛错。
- `code` 是不是在标准码表里；自定义码是不是 snake_case。
- 平台数字码有没有漏进 `code`；平台的原始响应有没有绕过来源层直接转给面板。
- 新的 HTTP 错误体是不是经 `respondFailure` 回的；附加字段有没有超出 `issues` / `upstreamCode`。
- 自动重试的逻辑有没有按「自动重试」那一列判：`indeterminate` 绝不重试。

## 出处

- [ADR-0026](../../adr/0026-failure-results.md)：决策 1（结果形状、抛错只留给 bug）、2（管与不管、`can`）、3（标准码表、自定义码、问题码、`reason` 改 snake、`unknown`）、4（改到的接口）、5（旧数据）、6（错误体的附加字段、`ok()` / `fail()` 与类型名）、「明确不做」。
- [ADR-0023](../../adr/0023-neutral-naming.md)：决策 6（错误体统一成 `{ code, message }`）、10（枚举值大小写）、11（`ok` 的例外、`upstreamCode`）。
- [ADR-0025](../../adr/0025-integrations.md)：决策 10（ctx 上的调用被拒或失败）。
- [ADR-0024](../../adr/0024-push-platform-adapter.md)：决策 14（`notifyMaster` 返回结果形状）。
- [docs/1.0/architecture.md](../../1.0/architecture.md)：「wire 契约」里的「失败只有一种形状」、「守卫」表的「错误体」。
- [docs/1.0/data-model.md](../../1.0/data-model.md)：「问题表」（问题码只要求 snake）。
- [docs/1.0/construction-plan.md](../../1.0/construction-plan.md)：第 1 期切片 ④（契约骨架，统一错误体）。
- 类型名对 [naming.md](naming.md) 的后缀表：操作的结果叫 `Result`。
