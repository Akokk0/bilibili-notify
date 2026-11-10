# CLAUDE.md

Bilibili-Notify monorepo 的工作指引。详细参考见文末「深入参考」。

## 项目

单 pnpm workspace monorepo:一套平台中立业务核心(`packages/`)+ 一个产品形态 —— **独立 Hono + React Dashboard**(`apps/`),发 Docker 镜像与 macOS / Windows 桌面应用,支持应用内自主升级。

业务核心包**全部 `private`、不发 npm**,独立端经 `workspace:*` 消费,不用 changesets。SDK与拓展创建器作为对外开发工具走npm;开发或准备发行前先读[ADR-0040](docs/adr/0040-extension-sdk-npm.md),施工见[第6期计划](docs/1.0/phase-6-plan.md)。Koishi 插件与 AstrBot 插件不在 dev 上、暂停更新,两端的维护线在 `koishi-astrbot-maintenance` 分支;它们以「薄的适配插件桥接到跑着的独立端」的形式接入,**接入点是 `extensions/bridge/`**(桥接是 BN 的第一个拓展,地址 `ws://<BN>/ext/bridge`,协议见 `extensions/bridge/PROTOCOL.md`,定案见 ADR-0012)。平台描述与连接设置规则已归内置适配器,改动它们或候选接口之前先读 `.claude/rules/connection-platforms.md`。推送链路各层(`apps/server/src/live/`、`apps/server/src/bilibili/dynamic/`、`apps/server/src/bilibili/live/session/`,与 `packages/push` / `packages/image`)只认独立端这一个宿主,不留可选钩子。

## 工具链与命令

工具链统一 **vp (vite-plus)** —— Node + 包管理器 + 任务运行的统一入口。它包裹 pnpm(读 `package.json#packageManager`);vp 1.0 起 PATH 上也有它托管的 `pnpm` shim(解析到同一个版本),但命令一律走 `vp`。简写:`vpr <script>` ≡ `vp run <script>`;`vpx <bin>` 跑二进制(本地 `node_modules/.bin` 优先,否则 `vp dlx`)。

```bash
vp install
vp run build           # 全 workspace 拓扑序构建
vp run typecheck       # 全 workspace tsc --noEmit
vp test                # vitest,全包;定向跑用 vp test <路径> --reporter=dot(只出点和汇总)。别用 vpx vitest:根不声明 vitest,会 dlx 一份野的 runner
vp run check           # Biome lint + format 检查(check:fix 自动修)
vp run dev:apps        # apps/server + apps/web 并行 dev,顺带 watch 打包仓里的拓展
vp run -F <pkg> build  # 构建单个包
vp run build:update-payload   # server 自包含 bundle + 装配 + web dist(Docker / 桌面 / 应用内更新共用的载荷)
```

- **`-F` filter 必须在 script 名之前**:`vp run -F <pkg> <script>`。写成 `vp run <script> -F <pkg>` 会把 `-F` 转发给 script(如 tsc)而出错。
- **测试文件一律 `import ... from "vite-plus/test"`,不从 `vitest`**:vitest 是 vite-plus 自带的,仓库里没有任何包声明它。`from "vitest"` 在嵌套于别的工程里的 checkout 可能被外层 node_modules 兜底而本地全绿,CI 干净安装必报 TS2307。
- Git hooks(Lefthook)在 `vp install` 时装好:pre-commit 跑 Biome,commit-msg 强制 conventional-commits。

## 顶层布局

```
packages/     平台中立业务核心(@bilibili-notify/*)
apps/         Hono 服务端 + React Dashboard + Tauri 桌面壳 + wire 契约(apps/contract)
extensions/   拓展 —— 经窄面 ctx 挂进宿主,不编在主程序里(第一个是机器人框架桥接)
```

单 workspace、单 lockfile,pnpm 默认 isolated 布局;`apps/server` 经 pnpm `workspace:*` 消费业务核心。包清单与模块图见 `docs/agents/architecture.md`。

## 硬约束(违反即 bug)

- **动手前先对仓库规范**:`docs/agents/conventions/`(索引是里面的 `README.md`)—— 命名(后缀表与词表)、失败形状与标准码、中立性、叫法、集成副作用只经 ctx、设置校验、统计收集、没有实现者的接口不造,每条一篇。都是活规范,加条、改条要主人拍板。

- **只管部分目录的硬约束在 `.claude/rules/`**,读到对应目录的文件时自动加载:写 UI 先查组件清单(`ui-components.md`)、拓展只从一扇门拿东西(`extension-door.md`)、server 自包含 bundle 与三种发行形态(`server-bundle.md`)、连接与平台闭集(`connection-platforms.md`)。

- **依赖卫生**:`src/` 里解析到运行时值(常量 / 类 / 函数)的 import,必须声明进该包 `package.json` 的 `dependencies`;`import type` 不用。类型增强(`declare module "x"`)也算 —— 解析不到就静默变成孤立声明。pnpm 是 isolated 布局,幻影依赖直接解析不到,不会像 hoisted 年代那样碰巧能跑。给 `packages/*` 加运行时第三方依赖(`vp add` 不会读到规则文件)之前,先读 `.claude/rules/server-bundle.md`:有的依赖内联进 bundle 后构建全绿、运行期才炸。
- **MessageBus**:`apps/server/src/runtime/message-bus.ts` 是唯一事件通道,绝不写 bus 与任何别的事件通道之间的转发器 —— 会自喂死循环爆栈。详见 `docs/agents/events.md`。

## 分支

- `dev` —— 活跃开发主干(独立端)。
- `main` —— GitHub 默认分支,发布快照。不触发任何发版。
- `koishi-astrbot-maintenance` —— Koishi 插件(`koishi/`)与 AstrBot 插件(`astrbot/`)的维护线;两端各自的发版 workflow 只认这条分支,dev 不含这两个目录。

独立端 Docker 镜像与 Desktop Release 由 `v<VERSION>` git tag 驱动;源码内独立端包版本保持 `0.0.0-dev`,发布 workflow 构建前按 tag 临时同步版本元数据。prerelease tag(如 `v0.1.0-alpha.7`)→Docker `:alpha`,纯 semver tag→`:latest`。`version-tag` workflow 是手动 tag helper,默认 dry-run;正式 tag 会分别触发 Docker、Desktop 与应用内更新载荷,三者互不阻塞。详见 `docs/agents/build-release.md`。

## 深入参考(`docs/agents/`)

- `architecture.md` —— 包清单、独立端模块图、服务依赖图
- `conventions/` —— 仓库规范:索引 `README.md` + 8 篇(命名:后缀表与词表、失败规矩、中立性、叫法、集成副作用只经 ctx、设置校验、统计收集、没有实现者的接口不造),每篇带出处与守卫
- `events.md` —— BusEvents 契约(事件名 → 具名载荷)、MessageBus 语义、WS channel 契约
- `push.md` —— 推送链路:来源与装配 → 适配 → 路由与闸 → 发送 → 投递 → 历史;闸的顺序、附加项的「生产 vs 推送」、不走这条链的三条旁路
- `subscriptions.md` —— 订阅:B 站 / 拓展两支与两个文件、身份 vs 订阅 id 两种键、资料与头像、订阅源拓展(清单 / 契约小号 / 解析门 / 上报的丢格与拒收)
- `build-release.md` —— 工具链、分支模型、Docker 镜像与 tag 方案、桌面产物布局
- `commands.md` —— 独立端私聊指令:入站链路、指令表、参数模型、可配置项;末尾是群里视频链接自动出卡片的「链接解析」
- `self-update.md` —— 应用内自主升级:载荷布局、`boot.mjs` 选版、双密钥与渠道入口、撤回与自愈
- `devtools.md` —— 开发版专属的 devtools(左下角药丸 + 底边面板):造状态 / 造事件的注册表、每种注入套在哪个边界上、真机验过什么
- `extension-marketplace.md` —— 拓展市场:官方索引怎么签、怎么发(`extension/<id>@<ver>` tag),第三方怎么自己开一个源,id 的命名空间规矩

## Agent skills

- **Issue tracker** —— GitHub Issues `Akokk0/bilibili-notify`,经 `gh` CLI;外部 PR 不作为 triage 来源。见 `docs/agents/issue-tracker.md`。
- **Triage labels** —— 三轴:流转 `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`(每条 issue 恒有且只有一个,新开自动打 `needs-triage`)、类型(GitHub 默认)、模块 `area:*`。标签都已建好,词表见 `docs/agents/triage-labels.md`。
- **Domain docs** —— 拷问定案后先落 ADR(`docs/adr/`,规矩见其 README)再动手;`CONTEXT.md` 暂无(`/grill-with-docs` 要调的 domain-modeling 本机没装)。见 `docs/agents/domain.md`。
