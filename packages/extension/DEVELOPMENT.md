# 拓展作者指南

本指南随SDK的npm包分发，安装后可直接读取，不需要访问BN主仓。公开类型的完整字段和注释在`index.d.mts`，构建辅助在`build.d.mts`。

## 版本与工程

宿主契约为 `apiVersion: 1`。群聊作品与来源扫码登录要求 `apiRevision: 1`，展示账号要求 `apiRevision: 2`，作品收藏数要求 `apiRevision: 3`。适配器如果依赖 `send` 第四个参数 `options.singleAttempt` 来关闭手动测试的重试，需要声明 `apiRevision: 4`。同一小号支持适配器在 `capabilities().inbound` 中返回 `groupTestReply: "token"`，让宿主使用纯文本群接收测试码。上报作品卡头说明（`post.label`）或图文附卡（`post.attachment`）要求 `apiRevision: 5`。只用原有能力的拓展仍可省略小号（按 0 处理）。SDK 的 npm 版本和拓展自己的 `version` 分别管理。使用新增能力时应声明对应小号并核对宿主兼容性。

创建器默认生成独立Git工程、示例来源、完整vp命令、锁文件、提交hooks与GitHub Actions：

```sh
pnpm create bn-ext@alpha
# 也可用 npm create bn-ext@alpha
cd my-extension
vp run verify
git add .
git commit -m "feat: create extension"
```

创建器使用`.node-version`固定Node，`packageManager`固定包管理器，开发依赖也固定版本。后续克隆用`vp install --frozen-lockfile`。若使用`--no-git`，先在工程根初始化自己的Git仓库，再运行`vp hooks enable`；安装过程会避开外层仓库。

终端向导询问工程目录、拓展 ID 和显示名，目录和显示名可按回车使用默认值。尚未创建 GitHub 仓库也可以开发和打包。脚本可用 `vp dlx create-bn-ext@alpha my-extension --id example.demo --name "Example"` 跳过向导。

`example.demo`里的`example`是市场命名空间，与GitHub的`owner`无关。第三方清单id必须包含这个命名空间；无点的id留给官方源。作者可选择自己的命名空间，但同一BN实例不允许两个不同来源占用同一命名空间。

## 源码拓展联调

`create-bn-ext`生成独立拓展；`@bilibili-notify/bn`直接取得并运行宿主成品。工具发布后：

```sh
vp dlx @bilibili-notify/bn@alpha dev
```

无需检出BN主仓或在隐藏目录构建宿主。正式运行使用`npx @bilibili-notify/bn@alpha web`；alpha发行期间入口带`@alpha`，本地审阅归档不代表已经发布。开发BN本体仍克隆主仓、按主仓指引使用vp。

启动器从npm包内解包宿主，并按版本与用途核对缓存。默认数据分别在`~/.bilibili-notify/dev-data`与`~/.bilibili-notify/data`；配置、凭据和其他持久数据位于该数据目录，启动配置文件为`bn.config.yaml`。可用`--data-dir <绝对目录>`明确指定；缓存删除不影响持久数据，其他实例的数据需要通过`--data-dir`显式指定。端口可用`--port`调整。npm包与依赖装好后，启动宿主不再下载载荷，也不需要额外的离线参数；删除缓存后仍可从包内重建。

拓展工程由创建器安装好依赖；已有工程先运行`vp install --frozen-lockfile`。只需启动BN，打开拓展页，点击“挂载开发拓展”，输入源码工程在BN机器上的绝对路径，再沿原开关启用。BN直接加载`src/index.ts`，负责运行、监听源码与子依赖、局部重载和收尾。工程不需要`dist/`，也没有独立的dev/start命令；`build`与打包用于生产。多个工程可同时挂载，保存一个只重载对应项。

源码及其导入依赖、设置规则与清单预检通过后，BN沿原生命周期停止旧实例、启动新版；预检失败会在卡片显示错误，旧实例继续运行，修正后恢复更新。停用项不会因保存而自动启用。需要开发场景时，在清单声明`contributes.devtools: {}`，具名导出`src/devtools/index.ts`中的`devtools()`。关闭BN时会停止实例与监听。用同一数据目录重启开发宿主时，只要挂载仍指向原工程，BN就会自动恢复挂载，沿用原来的监听设置和启用状态。手动解除挂载会移除挂载记录，保留源工程。

手动挂载存在于源码开发版和`bn dev`专用成品。`bn web`、Docker、桌面及普通生产构建没有此入口；运行期环境变量不能打开它。两个宿主使用相同默认端口时需先停止其中一个；多个拓展应挂到同一台开发BN。

## 订阅来源的账号和扫码

需要登录的来源在清单写 `apiVersion: 1`、`apiRevision: 1`，并在 `ctx.registerSource` 的 `auth` 提供 `SourceAuth`。宿主在「系统 → 账号」列出来源，并通过 `onChange` 重读同步的 `state()`、`account()`。独立来源分别登录和退出。仍在使用契约 1/0 的宿主会要求升级。

`beginLogin()` 生成新二维码。以 `awaiting-scan` 返回 `qr.dataUrl`（PNG data URL）和 ISO 格式的 `qr.expiresAt`。等待手机确认用 `confirming`。已有会话失效用 `expired`，二维码过期或无可用验证途径用 `error` 并给出可公开的原因。仅在上游确认凭据有效后进入 `logged-in`。

需要二次验证时，在 `confirming.verification` 提供以下一种操作。

- 短信验证码使用 `{ kind: "sms", attemptId }`。同一次发码与验码共享内存中的上游会话。每个挑战新建一个 1–128 位的随机公开标识（字母、数字、下划线或连字符），再用 `submitVerification(attemptId, code)` 接收 4–8 位数字。拓展在发请求和采用其结果前都须核对会话。新扫码、退出、停用时取消旧轮询和验码请求，忽略迟到的响应。
- 图形验证使用 `{ kind: "external", url }`。仅接受平台提供的官方 HTTPS 地址，拓展校验来源和跳转，等待用户在官方页面完成后继续向上游确认。

登录凭据按拓展隔离保存在 `ctx.secrets`。启动时读取并重新确认，退出时清除。验证码、上游票据与待扫会话只留内存；只把可公开的字段放进状态、账号、错误和日志。账号切换时中止旧账号的业务请求，使先发出的响应无法覆盖新状态。

## 包与入口

根目录保留`extension.json`。新模板将市场名称、命名空间和作者资料放在 `.bn-extension/marketplace.json`。发行ZIP包含构建后的`extension.json`、单文件`index.mjs`，可选`README.md`、`CHANGELOG.md`及`locales/<语言码>.json`；开发入口`devtools.mjs`不进入发行ZIP。

生产拓展运行时没有自己的`node_modules`。生成配置把SDK与第三方依赖内联到入口；增加依赖后仍需保持单入口、自包含构建。源码开发使用工程已安装的依赖，不能据此假定生产也能读取它们；发布前仍需实际构建与装包校验。原生插件和运行时额外读文件的依赖需要另行设计，不能只凭构建成功判断可运行。

SDK有两个入口：

| 入口 | 使用处 |
| --- | --- |
| `@bilibili-notify/extension` | `src/`中的类型、`ok`、`fail`、平台描述辅助 |
| `@bilibili-notify/extension/build` | 根构建配置中的`extensionPackageFiles`、`manifestWithSettingsFields` |

不要从宿主或私有`internal`取模块，也不要把`/build`导入运行源码。模块顶层只定义类型、规则和函数；宿主及构建插件可能多次导入入口，实际副作用在`activate`或来源/适配器的生命周期里开始。

## 先做一个订阅来源

清单的`contributes.subscription`描述外观、接受的搜索输入与支持的推送特性，运行入口通过`ctx.registerSource(def)`交给宿主。一个拓展只能登记一个订阅来源。

```ts
import type { ExtensionContext, SourceDef } from "@bilibili-notify/extension";
import { ok } from "@bilibili-notify/extension";
import { z } from "zod";

export const settingsSchema = z.object({
  greeting: z.string().default("Hello").meta({ label: "Greeting" }),
});

export function activate(ctx: ExtensionContext): void {
  const settings = ctx.settings(settingsSchema);
  const source: SourceDef = {
    start() {},
    stop() {},
    async searchCreators(query) {
      const read = settings.get();
      if (!read.ok) return read;
      const name = query.trim();
      return ok({ candidates: name ? [{ externalId: name, name }] : [] });
    },
  };
  ctx.registerSource(source);
}
```

`searchCreators`最多返回10个候选；查不到是成功的空数组。可选`fetchProfile(identity, signal)`拉取资料，`fetchLiveStatus(identity, signal)`提供在播状态；声明周期直播时必须实现后者。按每次调用的`signal`尽快中止请求。

`start(sourceCtx)`得到运行中的来源上下文：从`subscriptions()`读取自己平台的创作者名单，监听`onSubscriptionsChanged`，以`externalId`上报。`reportProfile`更新资料，`reportPost`交作品，`reportLive`交开播、状态或下播信号；具体载荷使用SDK的`ExtensionPostReport`、`ExtensionLiveSignalReport`等公开类型。直播`status`只更新状态，不触发推送。

作品上报和群聊链接预览可用 `post.stats.saves` 传收藏数。平台未给出数值时省略，明确为零时传 `0`。使用此字段的拓展要求 `apiRevision: 3`。

直播上报与 `fetchLiveStatus` 可以在 `details` 中提供 `heatScore`（平台直播热度）和 `vipViewers`（贵宾席人数），要求 `apiRevision: 5`。两项都接受非负整数，缺少时省略。开播与直播中的默认卡片会分别显示它们；`currentViewers` 和 `totalViewers` 仍分别表示全房此刻在线与本场累计观看。

`post.label` 是作品皮肤已有的卡头说明。拓展把要显示的文字排好再上报，例如「投稿了视频」或「来自 iPhone · 发布于 四川」。默认皮肤把它放在发布时间旁。正文和关键词过滤使用 `post.text`。

有主话题时，`post.topic` 给出名称，图标由皮肤绘制。

`post.attachment` 可附一张 `kind: "card"` 的卡片，必填 `title`。可选的 `cover` 是图库引用，`lines` 最多四行，每行一个 `{ text }`。可用 `button: { text, enabled }` 还原平台按钮的显示状态。推送图片里的按钮只展示文字。卡头说明、附卡标题及每行说明最长 256 字，按钮文字最长 128 字。

### 展示账号（API 1 修订 2）

`externalId`是稳定身份，始终用于候选选择、请求和上报。用户可读但可能改变的公开账号放在`CreatorProfileReport.displayId`，搜索候选和`fetchProfile`也用同一字段。省略时保留旧资料，空串清除，最长256字。界面优先展示该账号，缺失时显示原身份；不会按展示账号合并或迁移订阅。

清单的`contributes.subscription.displayIdNoun`声明该账号的叫法，`$manifest.contributes.subscription.displayIdNoun`提供译文；它只装短名词。使用展示账号时将清单`apiRevision`设为2，旧宿主会在加载前说明契约不兼容。简介`bio`仅保存创作者原文，展示账号独立提供。

拓展不持有BN内部订阅id，也不自己发送通知。宿主处理订阅开关、去重、规则、卡片、推送目标和历史。上报返回`void`，不把它当作发送回执；不合规的上报会留在宿主的上报问题记录里。

## 群聊作品链接

在根清单给订阅源声明可解析的网址。旧宿主看到小号 1 会提示升级。

```json
{
  "apiVersion": 1,
  "apiRevision": 1,
  "contributes": {
    "subscription": { "label": "作品来源", "supportedFeatures": ["post"] },
    "linkResolver": {
      "patterns": [
        { "host": "www.example.com", "pathPrefix": "/video/" },
        { "host": "www.example.com", "pathPrefix": "/note/" },
        { "host": "share.example.com", "pathPrefix": "/" }
      ]
    }
  }
}
```

`host` 填小写完整域名，每个子域分别列出。路径按段匹配，`/video` 匹配该路径和它的子路径，`/video/` 从该目录开始匹配。宿主只分派标准端口的 HTTP(S) 链接，裸域名补 HTTPS。来源在 `SourceDef.resolveLink(url, signal)` 收到命中的单条完整网址。把 `signal` 接到所有请求；短链展开用 `ctx.http.fetch` 的 `beforeHop` 在请求每一跳前检查协议、域名和端口，匿名展开时使用 `bare`。

成功返回 `ok({ postId, url, post })`，即 `Result<ExtensionLinkPreview>`。同一作品的各种链接都返回相同的 `postId`，`url` 填声明范围内的规范网址。即使没有该作者的订阅，`post.creator.name` 也必须有值；作品时刻、正文和图库引用沿用 `ExtensionPostReport`。获取失败返回 `fail(code, message)`。宿主执行逐群开关、额度与冷却，按配置回图片或文字，选原生分享时这类作品回落图片。停用来源会撤销解析并中止在途请求。

## 设置与副作用

设置规则只维护一份。入口导出`settingsSchema`并在`activate`交给`ctx.settings`；生成的构建配置用`extensionPackageFiles`把字段、默认值和说明写进`dist/extension.json`。推送连接的设置规则同理导出`connectionSettingsSchema`，写入`contributes.push.settingsFields`。

`settings.get()`返回`Result<{ settings }>`。规则不能通过时处理失败分支，不把错误当空对象。没有配置时，可通过默认值的规则仍可读取；需要主人补字段时返回`not_configured`。当前契约在激活期发现坏设置会拒绝启动；不要捕获后继续伪装成正常运行。

| 能力 | 使用方式 |
| --- | --- |
| 网络 | `ctx.http.fetch` / `websocket`，接上传入的中止信号；明确不需要浏览器身份及cookie时才选`bare` |
| 隔离登录会话（API 1 修订 1） | 顶层 `ctx.createCookieSession(saved?)` 创建独立内存罐。每跳用 `ingest(url, line)` 接收 Set-Cookie，`header(url)` 取该 URL 的 Cookie。宿主登记凭据脱敏。需恢复时将 `snapshot()` 字符串显式存入 `ctx.secrets`，坏快照抛出 TypeError。 |
| 状态 | `ctx.state`存公开业务状态，`ctx.secrets`存凭据；`http.`前缀由宿主保留 |
| 图片 | 通过`fetchImage`或`storeImage`得到图库引用，再交给上报载荷；不要把任意远端图地址冒充引用 |
| 定时与收尾 | `ctx.setTimeout` / `setInterval`、`signal`、`onDispose`；保存自己需要等待的任务并收尾 |
| 诊断 | `ctx.logger`、`reportProblem` / `resolveProblem`；日志的拓展id与级别由宿主处理 |
| 设置页 | `publishView`、`onAction`、`statusChanged`；动作名先在根清单声明 |
| 私有服务入口 | `mount` / `onUpgrade`申请宿主分配的入口，使用其实际前缀 |

宿主先调用来源/适配器的`stop`，随后中止上下文信号并执行收尾。`stop`先停止派发新工作，避免等待一个只能靠后续宿主中止信号结束的无限任务。长期请求、连接和循环必须能退出。

推送适配器通过`ctx.registerPlatformAdapter`登记，并在清单声明`contributes.push`。自己的连接及入站能力由适配器`start`收到的上下文提供；适配器键由宿主填成拓展id。它与订阅来源是两套接口，具体使用`PlatformAdapterDef`及其公开注释。

可选实现`createTestPayload(connection, destination, kind, samples)`，让推送目标页测试真实能力。使用宿主提供的图片、SILK语音和文字构造`NotificationPayload`，不在此方法发送；不支持时返回`unsupported`，不能发送纯文本替代品。省略此方法的旧适配器仍可测试普通文本。接收测试由宿主经既有入站入口核对短时测试码，适配器不用另开接口。明确的`audio`和`markdown`载荷不应降级为普通文本。

## 失败与译文

可预期失败返回`fail(code, message)`，成功返回`ok(...)`。`code`使用SDK的标准失败码；上游自己的错误码放`upstreamCode`。超时、限流、凭据失效与确实不存在分别处理；不要把所有错误都变成“找不到”。发送结果不明用`indeterminate`，不能自动重发。

给人看的拓展文字放在`locales/zh-CN.json`、`zh-TW.json`、`en.json`、`ja.json`，使用`ctx.i18n.t(key, values)`现取，不缓存翻译结果。未提供译文的语言按宿主回落规则处理。作者、创作者、输入和上游诊断原文不作为翻译键。

市场卡片复用这些文件里的`$manifest.name`和`$manifest.description`。当前版本的市场说明可写为普通译文键`marketplace.notes`；发布命令从实际构建的`dist/locales/`提取到索引的可选`locales`字段，不另建市场译文文件。缺项按“当前语言 → 简中 → 英文 → 默认文字”逐字段回落，历史CHANGELOG保留原文。

## 检查、安装与发布

```sh
vp run lint
vp run format
vp run format:check
vp run typecheck
vp run test
vp run build
vp run pack:extension
vp run release --tag v0.1.0 --dry-run
```

`verify`串起代码门禁、构建和打包；发布命令还复验Conventional Commits。ZIP与SHA256在`artifacts/`，可在BN拓展页上传安装。SDK版本变化不替你更改清单的宿主契约要求。

市场作者名默认为拓展命名空间，可在市场配置的 `owner.name` 修改。创建时若已确定仓库，可选传 `--repository owner/repo`，以 GitHub 所有者作为作者名初值，并在初始化 Git 时设置 `origin`。

准备发布时，GitHub Actions 从 `GITHUB_REPOSITORY` 取得目标仓库。本地预演和发布使用 `origin` 的推送地址。尚未设置时，先用 `git remote add origin <GitHub 仓库地址>` 添加，再用 `git remote get-url --push origin` 核对。

发布前更新根清单版本，提交修改，再打匹配的 `v<版本>` 标签并推送到自己的 GitHub 仓库。生成的 Release 工作流先以读取权限跑 dry-run，成功后发布作业才取得 `contents: write`。手动触发默认只验证。完整流程和中断重跑方法见生成工程的 README。

用户在BN“拓展 → 市场源”输入`owner/repository`或GitHub仓库网址，即定位到固定`bn-marketplace` Release上的`marketplace.json`。只支持公开可读取的索引和ZIP；第三方来源仍需用户信任，SDK和创建器不会赋予官方身份。
