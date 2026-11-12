# 拓展作者指南

本指南随SDK的npm包分发，安装后可直接读取，不需要访问BN主仓。公开类型的完整字段和注释在`index.d.mts`，构建辅助在`build.d.mts`。

## 版本与工程

当前宿主契约是`apiVersion: 1`、`apiRevision: 0`。SDK的npm版本、拓展自己的`version`与这两个契约数字各自独立。历史设计中的“v3”不是当前可安装的清单版本。

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

终端向导询问工程目录、拓展 ID 和显示名，目录和显示名可按回车使用默认值。尚未创建 GitHub 仓库也可以开发和打包。脚本可用 `vp dlx create-bn-ext@alpha my-extension --id example.demo --name "Example"` 跳过向导。首发版 `0.1.0-alpha.0` 的向导另会询问仓库。

`example.demo`里的`example`是市场命名空间，与GitHub的`owner`无关。第三方清单id必须包含这个命名空间；无点的id留给官方源。作者可选择自己的命名空间，但同一BN实例不允许两个不同来源占用同一命名空间。

## 源码拓展联调

`create-bn-ext`生成独立拓展；`@bilibili-notify/bn`直接取得并运行宿主成品。工具发布后：

```sh
vp dlx @bilibili-notify/bn@alpha dev
```

无需检出BN主仓或在隐藏目录构建宿主。正式运行使用`npx @bilibili-notify/bn@alpha web`；alpha发行期间入口带`@alpha`，本地审阅归档不代表已经发布。开发BN本体仍克隆主仓、按主仓指引使用vp。

启动器按版本与用途校验、缓存官方宿主。默认数据分别在`~/.bilibili-notify/dev-data`与`~/.bilibili-notify/data`，配置与凭据保存在该数据目录的`bn.config.yaml`。可用`--data-dir <绝对目录>`明确指定；缓存删除不影响持久数据，其他实例的数据需要通过`--data-dir`显式指定。端口可用`--port`调整，离线运行使用`--offline`及已经校验的缓存。

拓展工程由创建器安装好依赖；已有工程先运行`vp install --frozen-lockfile`。只需启动BN，打开拓展页，点击“挂载开发拓展”，输入源码工程在BN机器上的绝对路径，再沿原开关启用。BN直接加载`src/index.ts`，负责运行、监听源码与子依赖、局部重载和收尾。工程不需要`dist/`，也没有独立的dev/start命令；`build`与打包用于生产。多个工程可同时挂载，保存一个只重载对应项。

源码及其导入依赖、设置规则与清单预检通过后，BN沿原生命周期停止旧实例、启动新版；预检失败会在卡片显示错误，旧实例继续运行，修正后恢复更新。停用项不会因保存而自动启用。需要开发场景时，在清单声明`contributes.devtools: {}`，具名导出`src/devtools/index.ts`中的`devtools()`。解除或关闭BN时停止实例与监听，保留源工程；本次挂载不持久化，下次启动后重新指定。

手动挂载存在于源码开发版和`bn dev`专用成品。`bn web`、Docker、桌面及普通生产构建没有此入口；运行期环境变量不能打开它。两个宿主使用相同默认端口时需先停止其中一个；多个拓展应挂到同一台开发BN。

## 包与入口

根目录保留`extension.json`。`bn-extension/marketplace.json` 保存市场名称、命名空间和作者资料。发行ZIP包含构建后的`extension.json`、单文件`index.mjs`，可选`README.md`、`CHANGELOG.md`及`locales/<语言码>.json`；开发入口`devtools.mjs`不进入发行ZIP。

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

拓展不持有BN内部订阅id，也不自己发送通知。宿主处理订阅开关、去重、规则、卡片、推送目标和历史。上报返回`void`，不把它当作发送回执；不合规的上报会留在宿主的上报问题记录里。

## 设置与副作用

设置规则只维护一份。入口导出`settingsSchema`并在`activate`交给`ctx.settings`；生成的构建配置用`extensionPackageFiles`把字段、默认值和说明写进`dist/extension.json`。推送连接的设置规则同理导出`connectionSettingsSchema`，写入`contributes.push.settingsFields`。

`settings.get()`返回`Result<{ settings }>`。规则不能通过时处理失败分支，不把错误当空对象。没有配置时，可通过默认值的规则仍可读取；需要主人补字段时返回`not_configured`。当前契约在激活期发现坏设置会拒绝启动；不要捕获后继续伪装成正常运行。

| 能力 | 使用方式 |
| --- | --- |
| 网络 | `ctx.http.fetch` / `websocket`，接上传入的中止信号；明确不需要浏览器身份及cookie时才选`bare` |
| 状态 | `ctx.state`存公开业务状态，`ctx.secrets`存凭据；`http.`前缀由宿主保留 |
| 图片 | 通过`fetchImage`或`storeImage`得到图库引用，再交给上报载荷；不要把任意远端图地址冒充引用 |
| 定时与收尾 | `ctx.setTimeout` / `setInterval`、`signal`、`onDispose`；保存自己需要等待的任务并收尾 |
| 诊断 | `ctx.logger`、`reportProblem` / `resolveProblem`；日志的拓展id与级别由宿主处理 |
| 设置页 | `publishView`、`onAction`、`statusChanged`；动作名先在根清单声明 |
| 私有服务入口 | `mount` / `onUpgrade`申请宿主分配的入口，使用其实际前缀 |

宿主先调用来源/适配器的`stop`，随后中止上下文信号并执行收尾。`stop`先停止派发新工作，避免等待一个只能靠后续宿主中止信号结束的无限任务。长期请求、连接和循环必须能退出。

推送适配器通过`ctx.registerPlatformAdapter`登记，并在清单声明`contributes.push`。自己的连接及入站能力由适配器`start`收到的上下文提供；适配器键由宿主填成拓展id。它与订阅来源是两套接口，具体使用`PlatformAdapterDef`及其公开注释。

## 失败与译文

可预期失败返回`fail(code, message)`，成功返回`ok(...)`。`code`使用SDK的标准失败码；上游自己的错误码放`upstreamCode`。超时、限流、凭据失效与确实不存在分别处理；不要把所有错误都变成“找不到”。发送结果不明用`indeterminate`，不能自动重发。

给人看的拓展文字放在`locales/zh-CN.json`、`zh-TW.json`、`en.json`、`ja.json`，使用`ctx.i18n.t(key, values)`现取，不缓存翻译结果。未提供译文的语言按宿主回落规则处理。作者、创作者、输入和上游诊断原文不作为翻译键。

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

市场作者名默认为拓展命名空间，可在 `bn-extension/marketplace.json` 修改。创建时若已确定仓库，可选传 `--repository owner/repo`，以 GitHub 所有者作为作者名初值，并在初始化 Git 时设置 `origin`。

准备发布时，GitHub Actions 从 `GITHUB_REPOSITORY` 取得目标仓库。本地预演和发布使用 `origin` 的推送地址。尚未设置时，先用 `git remote add origin <GitHub 仓库地址>` 添加，再用 `git remote get-url --push origin` 核对。

旧工程升级到使用新路径的发布工具时，先把 `.bn/marketplace.json` 移至 `bn-extension/marketplace.json`，再从文件中删除 `repository` 字段。保留 `schemaVersion: 1` 和原来的作者与市场资料。继续使用 `create-bn-ext@0.1.0-alpha.0` 的工程沿用旧格式。

发布前更新根清单版本，提交修改，再打匹配的 `v<版本>` 标签并推送到自己的 GitHub 仓库。生成的 Release 工作流先以读取权限跑 dry-run，成功后发布作业才取得 `contents: write`。手动触发默认只验证。完整流程和中断重跑方法见生成工程的 README。

用户在BN“拓展 → 市场源”输入`owner/repository`或GitHub仓库网址，即定位到固定`bn-marketplace` Release上的`marketplace.json`。只支持公开可读取的索引和ZIP；第三方来源仍需用户信任，SDK和创建器不会赋予官方身份。
