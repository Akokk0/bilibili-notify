# CLAUDE.md

Bilibili-Notify monorepo 的工作指引。详细参考见文末「深入参考」。

## 项目

单 pnpm workspace monorepo:一套平台中立业务核心(`packages/`)+ 一个产品形态 —— **独立 Hono + React Dashboard**(`apps/`),发 Docker 镜像与 macOS / Windows 桌面应用,支持应用内自主升级。

核心包**全部 `private`、不发 npm**,独立端经 `workspace:*` 消费;registry 上不再有任何包(所以也不需要 changesets)。Koishi 插件与 AstrBot 插件已从 dev 移除、暂停更新,两端的维护线在 `koishi-astrbot-maintenance` 分支;后续以「薄的适配插件桥接到跑着的独立端」的形式回归,接入点是 `packages/internal` 的推送平台词表(`constants.ts` 的 `PUSH_TARGET_PLATFORMS`,schema 在 `schema/targets.ts`)+ `apps/server/src/platforms/` 的 adapter 矩阵 —— 引擎层(`packages/dynamic` / `live` / `push` / `image`)只认独立端这一个宿主,别再给它们留可选钩子。

## 工具链与命令

工具链统一 **vp (vite-plus)** —— Node + 包管理器 + 任务运行的统一入口。它包裹 pnpm(读 `package.json#packageManager`),但**不在 PATH 暴露 `pnpm` shim**,一律走 `vp`。简写:`vpr <script>` ≡ `vp run <script>`;`vpx <bin>` 跑二进制(本地 `node_modules/.bin` 优先,否则 `vp dlx`)。

```bash
vp install
vp run build           # 全 workspace 拓扑序构建
vp run typecheck       # 全 workspace tsc --noEmit
vp test                # vitest,全包;定向跑用 vp test <路径>(别用 vpx vitest,根不再声明 vitest,会 dlx 一份野的 runner)
vp run check           # Biome lint + format 检查(check:fix 自动修)
vp run dev:apps        # apps/server + apps/web 并行 dev
vp run -F <pkg> build  # 构建单个包
vp run build:update-payload   # server 自包含 bundle + 装配 + web dist(Docker / 桌面 / 应用内更新共用的载荷)
```

- **`-F` filter 必须在 script 名之前**:`vp run -F <pkg> <script>`。写成 `vp run <script> -F <pkg>` 会把 `-F` 转发给 script(如 tsc)而出错。
- **测试文件一律 `import ... from "vite-plus/test"`,不从 `vitest`**:vitest 是 vite-plus 自带的,仓库里没有任何包声明它。`from "vitest"` 在嵌套于别的工程里的 checkout 可能被外层 node_modules 兜底而本地全绿,CI 干净安装必报 TS2307(2026-09-03 栽过)。
- Git hooks(Lefthook)在 `vp install` 时装好:pre-commit 跑 Biome,commit-msg 强制 conventional-commits。

## 顶层布局

```
packages/   平台中立业务核心(@bilibili-notify/*)
apps/       Hono 服务端 + React Dashboard + Tauri 桌面壳 + wire 契约(apps/contract)
```

单 workspace、单 lockfile,pnpm 默认 isolated 布局;`apps/server` 经 pnpm `workspace:*` 消费业务核心。包清单与模块图见 `docs/agents/architecture.md`。

## 硬约束(违反即 bug)

- **写前端 UI 前先查组件清单**:`packages/ui`(`@bilibili-notify/ui`)是纯展示基础件库,给 web / desktop 写任何 UI **之前必须先读 `packages/ui/README.md` 的组件清单**——清单里有的组件不许重写。新增纯展示件(零业务依赖)进库并**同步更新清单**;缠 api/store/react-query 的留在 `apps/web/src/components`。库是源码直出(exports 指 src,无构建步),消费方入口 CSS 要 `@import "@bilibili-notify/ui/theme.css"` + `@source` 库的 src。

- **依赖卫生**:`src/` 里解析到运行时值(常量 / 类 / 函数)的 import,必须声明进该包 `package.json` 的 `dependencies`;`import type` 不用。类型增强(`declare module "x"`)也算 —— 解析不到就静默变成孤立声明。pnpm 是 isolated 布局,幻影依赖直接解析不到,不会像 hoisted 年代那样碰巧能跑。
- **MessageBus**:`apps/server/src/runtime/message-bus.ts` 是唯一事件通道,绝不写 bus 与任何别的事件通道之间的转发器 —— 会自喂死循环爆栈。详见 `docs/agents/events.md`。
- **server 是自包含 bundle(入口 + hash 分块,旁边没有 node_modules)**:给 `packages/*` 加**新第三方依赖**时,凡是运行时用 `__dirname` / `require.resolve` 去磁盘上读**自己包内文件**的(jieba-wasm 读 `.wasm`、jsdom 读 `xhr-sync-worker.js`),内联进 bundle 后**必炸**,且**构建全绿、只在运行期炸**。要么在 `scripts/assemble-server-bundle.mjs` 里随载荷拷资源并登记进 `scripts/server-bundle-assets.mjs`(装配自检 / 升级载荷 / 桌面资源三处共用那份清单),要么在 `apps/server/vite.config.ts` 的 bundle 配方里外置。加完新依赖务必 `vp run build:update-payload` 走一遍装配自检。
- **三种发行形态吃同一份载荷**:Docker 镜像、桌面安装包、应用内更新装的都是 `apps/server/dist`(bundle + 装配好的资产)+ web dist,桌面资源目录里**没有 node_modules**。桌面产物的布局只声明在 `apps/desktop/layout.json`,别在别处再抄一份路径。

## 分支

- `dev` —— 活跃开发主干(独立端)。
- `main` —— GitHub 默认分支,发布快照。不触发任何发版。
- `koishi-astrbot-maintenance` —— Koishi 插件(`koishi/`)与 AstrBot 插件(`astrbot/`)的维护线;两端各自的发版 workflow 只认这条分支,dev 不再含这两个目录。

独立端 Docker 镜像与 Desktop Release 由 `v<VERSION>` git tag 驱动;源码内独立端包版本保持 `0.0.0-dev`,发布 workflow 构建前按 tag 临时同步版本元数据。prerelease tag(如 `v0.1.0-alpha.7`)→Docker `:alpha`,纯 semver tag→`:latest`。`version-tag` workflow 是手动 tag helper,默认 dry-run;正式 tag 会分别触发 Docker、Desktop 与应用内更新载荷,三者互不阻塞。详见 `docs/agents/build-release.md`。

## 深入参考(`docs/agents/`)

- `architecture.md` —— 包清单、独立端模块图、服务依赖图
- `events.md` —— BiliEvents 契约、MessageBus 语义、WS channel 契约
- `build-release.md` —— 工具链、分支模型、Docker 镜像与 tag 方案、桌面产物布局
- `commands.md` —— 独立端私聊指令:入站链路、指令表、参数模型、可配置项;末尾是群里视频链接自动出卡片的「链接解析」
- `self-update.md` —— 应用内自主升级:载荷布局、`boot.mjs` 选版、双密钥与渠道入口、撤回与自愈

## Agent skills

- **Issue tracker** —— GitHub Issues `Akokk0/bilibili-notify`,经 `gh` CLI;外部 PR 不作为 triage 来源。见 `docs/agents/issue-tracker.md`。
- **Triage labels** —— 词表 `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`;目前仓库只有 `wontfix`,其余首次用前需 `gh label create`。见 `docs/agents/triage-labels.md`。
- **Domain docs** —— 单 context 仓库,`CONTEXT.md` + `docs/adr/` 在仓库根(由 `/grill-with-docs` 按需创建)。见 `docs/agents/domain.md`。
