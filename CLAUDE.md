# CLAUDE.md

Bilibili-Notify monorepo 的工作指引。详细参考见文末「深入参考」。

## 项目

单 pnpm workspace monorepo。一套平台中立业务核心,两种产品形态:

- **Koishi 插件**(`koishi/`)—— npm 发布单一包 `koishi-plugin-bilibili-notify`(**自包含 CJS bundle**,`@bilibili-notify/*` 全部内联)
- **独立 Hono + React Dashboard**(`apps/`)—— 后续主推形态,发 Docker 镜像

两端消费同一套 `@bilibili-notify/*` 核心包。核心包**全部 `private`、不发 npm** —— koishi 端靠内联、独立端与 AstrBot 靠 `workspace:*`,registry 上只有 koishi 插件一个包(所以也不需要 changesets)。

## 工具链与命令

工具链统一 **vp (vite-plus)** —— Node + 包管理器 + 任务运行的统一入口。它包裹 pnpm(读 `package.json#packageManager`),但**不在 PATH 暴露 `pnpm` shim**,一律走 `vp`。简写:`vpr <script>` ≡ `vp run <script>`;`vpx <bin>` 跑二进制(本地 `node_modules/.bin` 优先,否则 `vp dlx`)。

```bash
vp install
vp run build           # 全 workspace 拓扑序构建 + koishi 控制台 UI
vp run typecheck       # 全 workspace tsc --noEmit
vp test                # vitest,全包
vp run check           # Biome lint + format 检查(check:fix 自动修)
vp run dev:apps        # apps/server + apps/web 并行 dev
vp run -F <pkg> build  # 构建单个包
```

- **`-F` filter 必须在 script 名之前**:`vp run -F <pkg> <script>`。写成 `vp run <script> -F <pkg>` 会把 `-F` 转发给 script(如 tsc)而出错。
- Git hooks(Lefthook)在 `vp install` 时装好:pre-commit 跑 Biome,commit-msg 强制 conventional-commits。

## 顶层布局

```
packages/   平台中立业务核心(@bilibili-notify/*)
koishi/     Koishi 插件(koishi-plugin-bilibili-notify)
apps/       Hono 服务端 + React Dashboard
```

单 workspace、单 lockfile;`apps/server` 经 pnpm `workspace:*` 消费业务核心。包清单与各端模块图见 `docs/agents/architecture.md`。

## 硬约束(违反即 bug)

- **写前端 UI 前先查组件清单**:`packages/ui`(`@bilibili-notify/ui`)是纯展示基础件库,给 web / desktop 写任何 UI **之前必须先读 `packages/ui/README.md` 的组件清单**——清单里有的组件不许重写。新增纯展示件(零业务依赖)进库并**同步更新清单**;缠 api/store/react-query 的留在 `apps/web/src/components`。库是源码直出(exports 指 src,无构建步),消费方入口 CSS 要 `@import "@bilibili-notify/ui/theme.css"` + `@source` 库的 src。

- **路径**:`koishi/` 本身就是插件包根目录(已展平,不再有 `koishi/core/` 那层子目录)。若未来在 `koishi/` 下新增其他 koishi 包,目录名**不能含 `bilibili-notify` 子串** —— Koishi 插件加载器会混乱;npm 名与目录名解耦(在 `package.json#name` 设)。
- **依赖卫生**:`src/` 里解析到运行时值(常量 / 类 / 函数)的 import,必须声明进该包 `package.json` 的 `dependencies`;`import type` 不用。
- **MessageBus**:bus 与 koishi `ctx` 是同一事件通道的两个视图,绝不写 bus↔ctx 转发器 —— 会自喂死循环爆栈。详见 `docs/agents/events.md`。
- **koishi 是 bundle**:给 `packages/*` 加**新第三方依赖**时,凡是运行时用 `__dirname` / `require.resolve` 去磁盘上读**自己包内文件**的(jieba-wasm 读 `.wasm`、jsdom 读 `xhr-sync-worker.js`),内联进 bundle 后**必炸**,且**构建全绿、只在运行期炸**。要么随包拷资源(见 `scripts/copy-jieba-wasm.mjs`),要么在 `koishi/vite.config.ts` 的 `neverBundle` 里外置 + 写进 `koishi/package.json#dependencies`。加完新依赖后务必 `node -e "require('./koishi/lib/index.cjs')"` 验一次能加载。

## 分支

- `dev` —— 活跃开发主干,三类目录改动都落这;**koishi npm 发版也从这里触发**。
- `main` —— GitHub 默认分支,发布快照。不再触发任何发版。

**koishi 发版 = 改 `koishi/package.json` 的 `version` 并 push dev。**`publish.yml` 只认 version 字段变动(`scripts/koishi-version-changed.mjs`)——「`koishi/package.json` 变了」不算数,那个文件会被 `vp pack` 自动回写 `inlinedDependencies` / `exports`,每次构建都可能刷新。所以在 dev 上改 version 就是不可逆的发版动作,别顺手改。

独立端 Docker 镜像与 Desktop Release 由 `v<VERSION>` git tag 驱动;源码内独立端包版本保持 `0.0.0-dev`,发布 workflow 构建前按 tag 临时同步版本元数据。prerelease tag(如 `v0.1.0-alpha.7`)→Docker `:alpha`,纯 semver tag→`:latest`。`version-tag` workflow 是手动 tag helper,默认 dry-run;正式 tag 会分别触发 Docker 与 Desktop,二者互不阻塞(与 koishi 发版解耦)。详见 `docs/agents/build-release.md`。

## 深入参考(`docs/agents/`)

- `architecture.md` —— 包清单、各端模块图、服务依赖图、Koishi 配置模式与插件生命周期
- `events.md` —— BiliEvents 契约、MessageBus 语义、WS channel 契约
- `build-release.md` —— 工具链、分支模型、Docker 镜像与 tag 方案
- `commands.md` —— 独立端私聊指令:入站链路、指令表、参数模型、可配置项
- `self-update.md` —— 应用内自主升级:载荷布局、`boot.mjs` 选版、双密钥与渠道入口、撤回与自愈

## Agent skills

- **Issue tracker** —— GitHub Issues `Akokk0/bilibili-notify`,经 `gh` CLI;外部 PR 不作为 triage 来源。见 `docs/agents/issue-tracker.md`。
- **Triage labels** —— 词表 `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`;目前仓库只有 `wontfix`,其余首次用前需 `gh label create`。见 `docs/agents/triage-labels.md`。
- **Domain docs** —— 单 context 仓库,`CONTEXT.md` + `docs/adr/` 在仓库根(由 `/grill-with-docs` 按需创建)。见 `docs/agents/domain.md`。
