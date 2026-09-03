# 构建与发布参考

工具链、分支模型、Docker 镜像与 tag 方案。CLAUDE.md 的渐进式披露目标之一。

## 工具链

- **vp pack** —— 每个包只构建成 ESM(`.mjs`)+ 声明文件(`.d.mts`);消费方全是 ESM,CJS 产物随 koishi 插件一起退场
- **Biome** —— linter + formatter(tab 缩进,100 列)
- **Lefthook** —— `vp install` 时经 prepare 钩子自动装。pre-commit 对暂存的 `*.ts/.js/.mjs/.json` 跑 `biome check --staged --write`;commit-msg 跑 commitlint(强制 conventional-commits)
- **Vitest** —— 单测(`vp test`)
- **发版** —— 无版本编排工具(changesets 已弃用),registry 上没有任何包;独立端由 git tag `v<VERSION>` 驱动(见下)

## 门禁(`gate.yml`)—— 唯一定义,三条路径共用

`.github/workflows/gate.yml`(`on: workflow_call`)是**发版门禁**的唯一定义:Biome → build → typecheck → test。三条发布 workflow 与 CI 全部 `uses: ./.github/workflows/gate.yml`:

| workflow | 结构 |
| --- | --- |
| `ci.yml` | `gate` |
| `image-release.yml`(Docker) | `gate` → `build`(matrix) → `merge` |
| `desktop-release.yml`(Desktop) | `gate` → `build`(matrix) → `release` |
| `update-payload.yml`(应用内更新) | `gate` → `publish` |
| `revoke-update.yml`(撤回坏版本) | **不过门禁** —— 它一行代码都不发,只把渠道清单指回一个**已经发布过**的载荷(那次发版已经过过门禁)。给一件几十秒的急事加十几分钟没有意义,而且门禁红了也不说明这次撤回有问题。 |

**每条发布路径都过门禁,门禁不绿就不发。** 抽成 reusable workflow 是因为门禁是「这份代码能不能发出去」的判据 —— 三份各自维护的副本迟早会飘,而飘的方式一定是某条发布路径悄悄少了一项检查,且发布 workflow 还是全绿的。加新检查只改 `gate.yml` 一处。

一个**别踩**的点:

- **`assert-release-ref-on-dev.sh` 不是门禁。** 它只断言 tag 指向的 commit 在 `origin/dev` 上 —— 防的是「拿旁支 commit 发版」,不保证那个 commit 是绿的。dev 上一个测试红的 commit 照样能打 tag。堵这个口子的是 `gate`。

## 分支模型

单主干,不按产品形态分叉。

- **`dev`** —— 活跃开发主干(独立端:`packages/` + `apps/`)。
- **`main`** —— GitHub 默认分支,发布快照。不再触发任何发版。
- **`koishi-astrbot-maintenance`** —— Koishi 插件(`koishi/`)与 AstrBot 插件(`astrbot/`)的维护线。两端已暂停更新,dev 不再含这两个目录;它们各自的发版 workflow(`publish.yml` 发 npm、`astrbot-release.yml` squash-push 到独立仓)只存在于这条分支、也只认这条分支。要发维护版就在这条分支上改版本号再 push。

独立端从不发 npm —— 发布版本由 git tag `v<VERSION>` 驱动,再由 tag 分别触发 Docker 镜像、Desktop 产物与应用内更新载荷。

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
- `.github/workflows/update-payload.yml` —— 应用内更新的载荷 zip 与签名清单,挂到同一个 release,并覆盖滚动 tag `update-channel` 上的渠道清单。**没配 `BN_UPDATE_SIGNING_KEY` 时整条跳过并打 warning**,不让发版红着。详见 [self-update.md](./self-update.md)。

两个 workflow 都先校验 tag commit 可从 `origin/dev` 到达,再从 tag 读取版本并运行 `sync-standalone-version.sh`;Docker 与 Desktop 依赖同一个版本 tag,但彼此不再互相等待。某个 workflow 失败时只重跑对应 workflow。

不由 tag 触发、只手动跑的还有一条:

- `.github/workflows/revoke-update.yml` —— **撤回一个已经发出去的坏版本**。重签渠道清单把它列进 `revoked`,并把用户指向该在的那一版。与 `update-payload` 共用一个 concurrency 组(两者都在改 `update-channel` 上那两份清单)。默认 dry-run,不跑门禁。用法见 [self-update.md](./self-update.md)。

### 发布前验证

正式创建 tag 前先手动 dry-run:

- `version-tag`: `version=<VERSION>`, `dry_run=true` —— 校验 tag 格式与现有 tag 兼容性。
- `image-release`: `version=<VERSION>`, `dry_run=true` —— 构建但不 push Docker digest / manifest。
- `desktop-release`: `version=<VERSION>`, `dry_run=true` —— 构建并校验 Desktop artifacts,不创建 GitHub Release。
- `update-payload`: `version=<VERSION>`, `dry_run=true` —— 打载荷并签名,不上传任何资产。

### 桌面版装的是同一份自包含载荷

桌面安装包里的服务端**就是** Docker 镜像与应用内升级载荷用的那份 `apps/server/dist`
(`build:bundle` + `scripts/assemble-server-bundle.mjs`),摆在 `app/apps/server/lib/` 下,
dashboard 是它的同级 `web-dist/`。资源目录里**没有 node_modules**:以前生产端沿 node_modules
逐个搬运行时依赖再裁掉测试与文档,三百行只为拼出一棵能跑的依赖树,而应用内更新一装上,
桌面壳跑的就已经是 bundle 载荷了 —— 安装包自带那份没理由不同源。三种发行形态吃同一份产物,
`vp run build:desktop` 也就等于 `build:update-payload` + `tauri:build`。

bundle 必须带齐的文件(入口、选版器、词云 static、jieba wasm、jsdom 的 worker 与默认样式表、
配置样例、package.json)**只声明一次**:`scripts/server-bundle-assets.mjs`。装配脚本自检、
升级载荷把关、桌面资源准备三处都读它 —— 这些文件全是运行时按路径读盘的,少一个不会在构建期
报错,只会在用户点到那个功能时炸。

发版 workflow 里**版本同步在构建之前**:装配时写进 `dist/package.json` 的版本就是外壳起来后
`/api/health` 报的那个,顺序反了安装包会永远自报 `0.0.0-dev`。

### 桌面产物的布局只声明一次

`apps/desktop/layout.json` —— 起哪个入口、dashboard 摆哪、闸要查哪些文件,**只写在这里**。

有四个消费者:生产端 `apps/desktop/scripts/prepare-resources.mjs`(摆文件)、两个发版闸
`.github/scripts/assert-{macos,windows}-desktop-artifact.*`(查文件)、以及外壳
`apps/desktop/src-tauri/src/main.rs`(决定起什么)。前三个**运行时读同一份 JSON**;
外壳是 Rust,读不到(为一份三行的声明引 build.rs 不值当),所以那边留字面量,由
`scripts/desktop-release-gates.test.mjs` 核对它和声明说的是同一套。

那份守卫还盯着另一件事:**谁都不许把路径抄回自己家里**。抄回去的那份可以静静地落后 ——
macOS 那条闸只查文件存在,落后了照样绿,而用户拿到的是一个起不来的包(2026-09-02 真栽过)。

Desktop dry-run 的 CI smoke 覆盖 artifact 内容、GUI subsystem、packaged Node sidecar、`/api/health` 与 dashboard HTML。它**不是**完整 GUI E2E —— 托盘图标、无控制台窗口、NSIS 安装启动、退出后无残留 sidecar 这些只有 Windows 实机能看。**别每次发版都拿这个去提示用户**(他知道),要提也只在真动了 Desktop 壳 / 托盘 / sidecar 生命周期时提一次。

### Docker tag 方案

渠道按 tag 版本串判定:version 含 prerelease 标识(有 `-`,如 `0.1.0-alpha.0`)走 alpha,纯 semver 走正式。

| Tag | 来源 |
|---|---|
| `:alpha` | git tag version 是 prerelease(`X.Y.Z-alpha.N`)—— 滚动渠道 tag |
| `:latest` | git tag version 是纯 semver(`X.Y.Z`)—— 滚动渠道 tag |
| `:vX.Y.Z[-alpha.N]` | 不可变版本 tag,跟 git tag `v<VERSION>` 走 |
| `:<short-sha>` | 每个构建 —— 不可变,用于回滚 / 精确 pin |

每个发布同时产出 **`-slim` 变体**(Dockerfile `--target runtime-slim`,无 chromium,
卡片渲染走 `BN_CHROME_ENDPOINT` 远程浏览器):上表四类 tag 各有对应的 slim 形态
`:slim` / `:alpha-slim` / `:vX.Y.Z[-alpha.N]-slim` / `:<short-sha>-slim`,由同一个
image-release run 在相同 build job 里顺带构建(同 buildx 实例复用 builder 层)。

发 alpha:在目标 commit 上创建并推送 `vX.Y.Z-alpha.N`。发正式版:创建并推送 `vX.Y.Z`。

## Docker 镜像(独立端)

镜像仓库:Docker Hub `docker.io/akokk0/bilibili-notify`,GHCR `ghcr.io/akokk0/bilibili-notify`。

### Dockerfile

`apps/Dockerfile` 多阶段:builder 跑 `pnpm install` + 按需构建(`packages/*` → `apps/web` → `apps/server` 的 `build:bundle` + `scripts/assemble-server-bundle.mjs`);runtime `FROM` 自建 chromium base,只 COPY server 的**自包含单文件 bundle**(~15MB,含 wasm / worker / 词云 static / package.json)+ web dist。镜像里**没有 node_modules**。

**chromium base 镜像**(`apps/base.Dockerfile` → `akokk0/bilibili-notify-base`):node-slim + chromium + CJK/emoji 字体 + tini,~300MB 冻结在 base、digest 只随显式重建而变 —— 用户拉一次、之后每次升级只下 app 小层。重建走 `base-image.yml`(workflow_dispatch,不可变递增 tag `b1`/`b2`/… + `:latest`,双 arch 经 QEMU),刷新后 bump `apps/Dockerfile` 的 `ARG BN_BASE_IMAGE`。**时序**:新 base tag 必须先推上 registry,image-release(含 dry-run)才构建得动。

builder 故意用 **corepack 提供的 pnpm,不是 vp** —— 这是对「全仓 vp」工具链的有意例外,与 `publish.yml` 的 corepack 处理一致(corepack 在 node 基础镜像里免费自带、vp 没有 Docker 侧的 bootstrap action;两者解析到同一个 pinned pnpm,产物逐字节一致)。package.json script 里的 `vp` 由 pnpm run 从根 devDependency(vite-plus)的 `node_modules/.bin` 解析,builder 无需全局 vp。

**构建上下文必须是仓库根,不是 `apps/`** —— `apps/server` 经 `workspace:*` 依赖 `packages/*`,单独的 `apps/` 解析不到。手动构建:

```bash
docker build -f apps/Dockerfile -t bilibili-notify:dev .
```

`apps/docker-compose.example.yaml` 是部署模板。
