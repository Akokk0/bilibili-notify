# 构建与发布参考

工具链、分支模型、Docker 镜像与 tag 方案。CLAUDE.md 的渐进式披露目标之一。

## 工具链

- **tsdown** —— 每个包构建成 ESM(`.mjs`)+ CJS(`.cjs`)+ 声明文件
- **Biome** —— linter + formatter(tab 缩进,100 列);Vue 文件在 lint 范围内
- **Lefthook** —— `vp install` 时经 prepare 钩子自动装。pre-commit 对暂存的 `*.ts/.js/.mjs/.json` 跑 `biome check --staged --write`;commit-msg 跑 commitlint(强制 conventional-commits)
- **Vitest** —— 单测(`vp test`)
- **发版** —— 无版本编排工具(changesets 已弃用)。registry 上只有 `koishi-plugin-bilibili-notify` 一个包,版本号手改 `koishi/package.json`,`scripts/publish.mjs` 从版本号推导 dist-tag 并做幂等发布

## 门禁(`gate.yml`)—— 唯一定义,四条路径共用

`.github/workflows/gate.yml`(`on: workflow_call`)是**发版门禁**的唯一定义:Biome → build → typecheck → test。四条 workflow 全部 `uses: ./.github/workflows/gate.yml`:

| workflow | 结构 |
| --- | --- |
| `ci.yml` | `gate` |
| `publish.yml`(koishi npm) | `detect` → `gate` → `publish` |
| `image-release.yml`(Docker) | `gate` → `build`(matrix) → `merge` |
| `desktop-release.yml`(Desktop) | `gate` → `build`(matrix) → `release` |

**CI 不跑 astrbot 的 Python 门禁**(2026-07-11 拍板去掉)。三条发布路径的产物里都没有一行 Python;astrbot 走 `astrbot-release.yml` 那条独立的 squash-push 路线,不经过 `gate`。

Python 检查改为**只在发版时手动跑** —— `release-astrbot` skill 的步骤里有 `vp run check:astrbot-python`(ruff check + `format --check` + pytest)那一步。⚠️ 代价是**日常 push 不再拦 Python 的错**,要到发 astrbot 那一刻才暴露。

**每条发布路径都过门禁,门禁不绿就不发。** 抽成 reusable workflow 是因为门禁是「这份代码能不能发出去」的判据 —— 四份各自维护的副本迟早会飘,而飘的方式一定是某条发布路径悄悄少了一项检查,且发布 workflow 还是全绿的。加新检查只改 `gate.yml` 一处。

两个**别踩**的点:

- **`publish.yml` 的 `publish` job 里那个 `vp run build` 不是重复。** npm 打包的是 `koishi/lib/`(gitignored,只在构建时生成),而 gate 跑在**另一个 runner** 上,产物带不过来。删掉它就会发出一个空壳包。gate 里的 build 是门禁(编译得过),publish 里的 build 是产物。
- **`assert-release-ref-on-dev.sh` 不是门禁。** 它只断言 tag 指向的 commit 在 `origin/dev` 上 —— 防的是「拿旁支 commit 发版」,不保证那个 commit 是绿的。dev 上一个测试红的 commit 照样能打 tag。堵这个口子的是 `gate`。

## 分支模型

单主干 + 三个并存顶层目录(`packages/` / `koishi/` / `apps/`),不按产品形态分叉。

- **`dev`** —— 活跃开发主干。`packages/` `koishi/` `apps/` 三类改动都落这。**koishi npm 发版也从这里触发。**
- **`main`** —— GitHub 默认分支,发布快照。不再触发任何发版。

两种产品形态发布节奏独立:koishi 端发 npm —— push dev 且 `koishi/package.json#version` 变动时触发(`publish.yml`);独立端(Server + Web + Desktop)从不发 npm —— 发布版本由 git tag `v<VERSION>` 驱动,再由 tag 分别触发 Docker 镜像与 Desktop 产物。二者互不牵动。

### koishi 发版步骤

koishi 插件是**自包含单文件产物**:九个 `@bilibili-notify/*` 内部包全部被内联进 `koishi/lib/index.cjs`(`koishi/vite.config.ts` 的 `deps.alwaysBundle`),因此它们已 `private`、不再发 npm。registry 上只剩插件这一个包 —— **没有版本联动要算,所以不需要 changesets**。

**发版 = 改 `koishi/package.json#version` 并 push dev。** 没有别的闸门,改完推上去就发出去了。

1. **改版本**:编辑 `koishi/package.json#version`,手写 `koishi/CHANGELOG.md`。
2. **发版**:提交并 push dev → `publish.yml` 跑门禁后执行 `node scripts/publish.mjs`。

### 为什么发版闸门只认 version 字段

`publish.yml` 的 `paths` 过滤只是粗筛,真正判定发不发的是 `scripts/koishi-version-changed.mjs` —— 它比对 push 前后 `koishi/package.json` 的 **`version` 字段本身**。

不能拿「`koishi/package.json` 变了」当信号:`vp pack` 开了 `exports: true`,会自动回写这个文件的 `inlinedDependencies` / `exports`,**每次构建都可能刷新它**。以文件变动为准 = 每次构建发一版。

两道闸各管一件事,别混:

- **`koishi-version-changed.mjs`(快速门)** —— 版本号没动就别启动整条 CI(lint + build + typecheck + test 是分钟级的)。它**不是**安全闸:workflow 被重跑时 `github.event.before` 还是老的,它会再判一次 changed。所以它拿不准时(空 sha / 首次 push)一律放行。
- **`scripts/publish.mjs`(安全闸)** —— 发布前查 registry,版本已存在就安静跳过。这才是防重复发布的那一道。它同时接住了 changesets 原本兜的 **dist-tag 推导**:`5.0.0-alpha.9` → npm tag `alpha`;`5.0.0` → `latest`,与独立端 `v<VERSION>` tag 同一套心智。

产物构成与体积:插件把内部包**和它们的第三方依赖**(vue / openai / protobufjs / 两个大版本的 cron …)一并内联,tree-shaking 后 `index.cjs` ≈ 4.4MB。两个例外:

- **jieba-wasm** —— 只内联 JS 胶水。它的 npm 包里有四份等大的 wasm(deno / nodejs / web / bundler,共 16MB),external 的话用户全得下载。胶水运行时用 `path.join(__dirname, "jieba_rs_wasm_bg.wasm")` 读二进制,CJS 产物里 `__dirname` 正好是 `lib/` —— 所以 `scripts/copy-jieba-wasm.mjs` 在 pack 后把 nodejs 那一份(3.8MB)拷进去。**这也是只发 CJS 的原因之一**:ESM 里 `__dirname` 是 undefined,会直接 TypeError。
- **jsdom** —— 保持 external(留在 `dependencies`)。它运行时 `require.resolve("./xhr-sync-worker.js")` 去磁盘上找兄弟文件、还会 fork 子进程,内联后一 require 插件就 MODULE_NOT_FOUND。

## 独立端版本与 tag

### git tag = 唯一发布事实源

独立端发布版本取自 git tag 名 `v<VERSION>`,例如 `v0.1.0-alpha.7`。源码中的独立端版本元数据保持开发占位 `0.0.0-dev`;发布 workflow 在构建前运行 `.github/scripts/sync-standalone-version.sh`,按 tag 或手动 dry-run 输入把以下文件临时改成发布版本:

- `apps/server/package.json#version` —— 后端运行时 `/api/health.version` 与 Docker 镜像内版本。
- `apps/web/package.json#version` —— 前端概览页展示。
- `apps/desktop/package.json#version`、`apps/desktop/src-tauri/tauri.conf.json#version`、`apps/desktop/src-tauri/Cargo.toml` / `Cargo.lock` —— Desktop/Tauri bundle 与安装器元数据。

这些改动只发生在 CI checkout / Docker build context 里,不需要回写仓库。`apps/server`、`apps/web`、`apps/desktop` 都是 `private`、永不发 npm。

运行时 `resolveAppVersion`(`apps/server/src/routes/health.ts`)读构建时已同步的 `apps/server/package.json#version`;`/api/health` 的 `version` 与概览页「后端 X」据此显示。Desktop workflow 中 web dist 的前端版本由 `BN_STANDALONE_VERSION` 注入,因此 apps runtime 可先于版本文件 sync 构建;Tauri/Cargo/server package 元数据仍在 bundle 前 sync。

### Tag 创建(`.github/workflows/version-tag.yml`)

发版方式是创建并推送 `v<VERSION>` tag。可以本地手动打 tag,也可以手动触发 `version-tag` workflow 作为 tag helper:

- `workflow_dispatch` 输入 `version`。
- `dry_run=true`(默认)只校验版本格式与现有 tag 兼容性,打印将创建的 tag。
- `dry_run=false` 时用 `RELEASE_PAT` 在当前 `dev` HEAD 创建或校验 annotated tag `v<VERSION>`。

不再通过 bump `apps/server/package.json#version` 触发发版;该文件只是开发占位,发布时由 CI 从 tag 临时同步。

### Docker 镜像与 Desktop 触发

推送 `v<VERSION>` tag 后,两个 release workflow 独立触发:

- `.github/workflows/image-release.yml` —— Docker Hub `docker.io/akokk0/bilibili-notify` 与 GHCR `ghcr.io/akokk0/bilibili-notify`。
- `.github/workflows/desktop-release.yml` —— macOS / Windows Desktop 产物与 GitHub Release assets。

两个 workflow 都先校验 tag commit 可从 `origin/dev` 到达,再从 tag 读取版本并运行 `sync-standalone-version.sh`;Docker 与 Desktop 依赖同一个版本 tag,但彼此不再互相等待。某个 workflow 失败时只重跑对应 workflow。

### 发布前验证

正式创建 tag 前先手动 dry-run:

- `version-tag`: `version=<VERSION>`, `dry_run=true` —— 校验 tag 格式与现有 tag 兼容性。
- `image-release`: `version=<VERSION>`, `dry_run=true` —— 构建但不 push Docker digest / manifest。
- `desktop-release`: `version=<VERSION>`, `dry_run=true` —— 构建并校验 Desktop artifacts,不创建 GitHub Release。

Desktop dry-run 的 CI smoke 覆盖 artifact 内容、GUI subsystem、packaged Node sidecar、`/api/health` 与 dashboard HTML。它**不是**完整 GUI E2E —— 托盘图标、无控制台窗口、NSIS 安装启动、退出后无残留 sidecar 这些只有 Windows 实机能看。**别每次发版都拿这个去提示用户**(他知道),要提也只在真动了 Desktop 壳 / 托盘 / sidecar 生命周期时提一次。

### Docker tag 方案

渠道按 tag 版本串判定:version 含 prerelease 标识(有 `-`,如 `0.1.0-alpha.0`)走 alpha,纯 semver 走正式。

| Tag | 来源 |
|---|---|
| `:alpha` | git tag version 是 prerelease(`X.Y.Z-alpha.N`)—— 滚动渠道 tag |
| `:latest` | git tag version 是纯 semver(`X.Y.Z`)—— 滚动渠道 tag |
| `:vX.Y.Z[-alpha.N]` | 不可变版本 tag,跟 git tag `v<VERSION>` 走 |
| `:<short-sha>` | 每个构建 —— 不可变,用于回滚 / 精确 pin |

发 alpha:在目标 commit 上创建并推送 `vX.Y.Z-alpha.N`。发正式版:创建并推送 `vX.Y.Z`。

## Docker 镜像(独立端)

镜像仓库:Docker Hub `docker.io/akokk0/bilibili-notify`,GHCR `ghcr.io/akokk0/bilibili-notify`。

### Dockerfile

`apps/Dockerfile` 多阶段:builder 跑 `pnpm install` + 按需构建(`packages/*` → `apps/web` → `apps/server` 的 `build:bundle` + `scripts/assemble-server-bundle.mjs`);runtime `FROM` 自建 chromium base,只 COPY server 的**自包含单文件 bundle**(~15MB,含 wasm / worker / 词云 static / package.json,配方对齐 astrbot sidecar)+ web dist。镜像里**没有 node_modules**。

**chromium base 镜像**(`apps/base.Dockerfile` → `akokk0/bilibili-notify-base`):node-slim + chromium + CJK/emoji 字体 + tini,~300MB 冻结在 base、digest 只随显式重建而变 —— 用户拉一次、之后每次升级只下 app 小层。重建走 `base-image.yml`(workflow_dispatch,不可变递增 tag `b1`/`b2`/… + `:latest`,双 arch 经 QEMU),刷新后 bump `apps/Dockerfile` 的 `ARG BN_BASE_IMAGE`。**时序**:新 base tag 必须先推上 registry,image-release(含 dry-run)才构建得动。

builder 故意用 **corepack 提供的 pnpm,不是 vp** —— 这是对「全仓 vp」工具链的有意例外,与 `publish.yml` 的 corepack 处理一致(corepack 在 node 基础镜像里免费自带、vp 没有 Docker 侧的 bootstrap action;两者解析到同一个 pinned pnpm,产物逐字节一致)。package.json script 里的 `vp` 由 pnpm run 从根 devDependency(vite-plus)的 `node_modules/.bin` 解析,builder 无需全局 vp。

**构建上下文必须是仓库根,不是 `apps/`** —— `apps/server` 经 `workspace:*` 依赖 `packages/*`,单独的 `apps/` 解析不到。手动构建:

```bash
docker build -f apps/Dockerfile -t bilibili-notify:dev .
```

`apps/docker-compose.example.yaml` 是部署模板。

## AstrBot 插件发布(独立仓)

AstrBot 插件发布到独立仓 `Akokk0/astrbot_plugin_bilibili_notify`(AstrBot 插件市场按普通仓拉取)。版本事实源是 `astrbot/core/metadata.yaml#version`。发布把 `astrbot/core` **工作目录**(含 gitignored 但运行必需的构建产物 `sidecar/app` + `pages/dashboard`)作为单个 squash 提交 push 到独立仓 `main`,由 `scripts/release-astrbot-core.mjs`(`vp run release:astrbot-core`)完成 —— 不是 git tree 快照。

CI:`.github/workflows/astrbot-release.yml`,**监测 `metadata.yaml#version` 变化**驱动(不打 tag):

- **正式发布**:dev 上 `astrbot/core/metadata.yaml` 的 `version` 改动(bump)并 push → 自动发布。workflow 用 `astrbot-version-changed.sh` 比对 HEAD~1,`version` 没变(只改了别的字段)则跳过。
- **预演**:`workflow_dispatch` 勾 `dry_run`(默认 true)—— 强制走、只 `vp run build:astrbot` + `release:astrbot-core --dry-run`,不推送。
- 跨仓 push 用 secret `RELEASE_PAT`,经 `ASTRBOT_RELEASE_REMOTE=https://x-access-token:<PAT>@github.com/...` 注入,发布脚本本身不改。`RELEASE_PAT` 须对独立仓有 `contents:write`(fine-grained PAT 需把该仓加进 repository access)。

AstrBot 发布与 koishi npm、独立端 Docker/Desktop **互不牵动**,各自独立触发。本地仍可直接 `vp run release:astrbot-core`(先 `vp run build:astrbot`),但 CI 路径内建 dry-run、更安全(规避脚本注释记录的"`--` 转发把 dry-run 跑成真推送"那类本地坑)。
