# BN 拓展：agent 契约指引

实现细节查[作者指南](DEVELOPMENT.md)。准确的接口字段以当前安装版本的 `index.d.mts` 和 `build.d.mts` 为准；SDK 的 npm 版本与清单中的宿主 API 版本分别管理。

## 入口与构建

- 运行入口具名导出 `activate(ctx: ExtensionContext)`。默认对象里的 `activate` 不是宿主入口。
- 运行代码只从 `@bilibili-notify/extension` 获取 BN 契约；`/build` 只用于根构建配置。使用公开类型，不从私有宿主模块补接口。
- 模块顶层只定义规则和函数。构建插件会导入入口，副作用在激活或来源、适配器生命周期中开始。
- `settingsSchema`、`connectionSettingsSchema` 由入口导出，构建插件生成清单字段；同一套设置规则同时交给 ctx，不维护第二份字段表。
- 产物是自包含的 `index.mjs`，运行时没有独立的 `node_modules`。增加依赖后核对构建产物是否仍能独立导入。

## 契约查找

| 任务                           | 从公开类型开始                                                   |
| ------------------------------ | ---------------------------------------------------------------- |
| 搜索创作者、获取资料、轮询订阅 | `SourceDef`、`ExtensionSourceContext`                            |
| 作品和直播上报                 | `ExtensionPostReport`、`ExtensionLiveSignalReport`               |
| 推送出口、探测和发送           | `PlatformAdapterDef`、`PlatformAdapterContext`、`DeliveryResult` |
| 设置及设置页动作               | `SettingsReader`、`ExtensionContext`、`ExtensionView`            |

## 容易误用的边界

- `settings.get()` 返回 `Result<{ settings }>`；先处理失败，再读 `result.settings`。
- 请求、WebSocket、图片、定时器、状态、凭据与日志经 ctx；状态写入也返回 Result，检查写入结果。凭据存 `ctx.secrets`，临时凭据先交 `ctx.redact`。
- 来源只持有 `externalId`，用上报接口交给宿主；订阅 UUID、规则、路由、发送和历史由宿主负责。上报返回 `void`，不是发送回执；直播 `status` 不触发推送。
- `stop()` 先停止新工作与上报；宿主随后中止上下文信号并收尾。不要在 `stop()` 里无限等待只能靠后续中止信号结束的任务。
- 成功用 `ok`，预期失败用 `fail` 和标准失败码。发送结果不明用 `indeterminate`，不能当作未发送而自动重试。
- 展示文字由 `ctx.i18n.t` 现取；用户输入、创作者原文及上游诊断不改写成翻译键。

## 能力缺口

当前 SDK 没有的能力先说明具体使用场景和缺少的契约，不借私有 import、直接修改宿主配置或伪造成功结果绕过。拓展清单、SDK 类型和宿主版本需要共同满足兼容性。
