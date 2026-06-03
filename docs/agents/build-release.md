# 构建与发布参考

工具链、分支模型、Docker 镜像与 tag 方案。CLAUDE.md 的渐进式披露目标之一。

## 工具链

- **tsdown** —— 每个包构建成 ESM(`.mjs`)+ CJS(`.cjs`)+ 声明文件
- **Biome** —— linter + formatter(tab 缩进,100 列);Vue 文件在 lint 范围内
- **Lefthook** —— `vp install` 时经 prepare 钩子自动装。pre-commit 对暂存的 `*.ts/.js/.mjs/.json` 跑 `biome check --staged --write`;commit-msg 跑 commitlint(强制 conventional-commits)
- **Vitest** —— 单测(`vp test`)
- **Changesets** —— 发版工具。`updateInternalDependencies: "patch"` 只**同步下游消费者 `package.json` 里的版本范围**,不会自动把可发布的下游包纳入发布。当包 A 的改动影响到可发布包 B 的运行时行为,B 必须显式列进 changeset frontmatter

## 分支模型

单主干 + 三个并存顶层目录(`packages/` / `koishi/` / `apps/`),不按产品形态分叉。

- **`dev`** —— 活跃开发主干。`packages/` `koishi/` `apps/` 三类改动都落这。
- **`main`** —— GitHub 默认分支,旧版发布快照。`dev → main` 合并触发 koishi changesets npm 发版(`publish.yml` 监听 push to `main`)。

两种产品形态发布节奏独立:koishi 端经 changesets 发 npm —— `dev → main` 合并触发(`publish.yml`);独立端(Server + Web + Desktop)从不发 npm —— 发布版本由 git tag `v<VERSION>` 驱动,再由 tag 分别触发 Docker 镜像与 Desktop 产物。`dev → main` 合并**不**触发独立端构建,koishi 发版与独立端发版互不牵动。

## 独立端版本与 tag

### git tag = 唯一发布事实源

独立端发布版本取自 git tag 名 `v<VERSION>`,例如 `v0.1.0-alpha.7`。源码中的独立端版本元数据保持开发占位 `0.0.0-dev`;发布 workflow 在构建前运行 `.github/scripts/sync-standalone-version.sh`,按 tag 或手动 dry-run 输入把以下文件临时改成发布版本:

- `apps/server/package.json#version` —— 后端运行时 `/api/health.version` 与 Docker 镜像内版本。
- `apps/web/package.json#version` —— 前端概览页展示。
- `apps/desktop/package.json#version`、`apps/desktop/src-tauri/tauri.conf.json#version`、`apps/desktop/src-tauri/Cargo.toml` / `Cargo.lock` —— Desktop/Tauri bundle 与安装器元数据。

这些改动只发生在 CI checkout / Docker build context 里,不需要回写仓库。`apps/server`、`apps/web`、`apps/desktop` 都是 `private`、永不发 npm,且进了 `.changeset/config.json` 的 `ignore` —— changeset 完全不碰它们,业务包改动也不会连带 bump 它们。

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

Desktop dry-run 的 CI smoke 覆盖 artifact 内容、GUI subsystem、packaged Node sidecar、`/api/health` 与 dashboard HTML。它不是完整 GUI E2E;正式 tag 前仍要在 Windows 实机确认托盘图标、无控制台窗口、NSIS 安装启动、退出后无残留 sidecar。

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

`apps/Dockerfile` 多阶段:builder 在整个 monorepo 上跑 `pnpm install` + `pnpm -r run build` → runtime 是 `node:24-bookworm-slim` + chromium + tini,只带构建产物与 prod 依赖。

builder 故意用 **corepack 提供的 pnpm,不是 vp** —— 这是对「全仓 vp」工具链的有意例外,与 `publish.yml` 的 corepack 处理一致(corepack 在 node 基础镜像里免费自带、vp 没有 Docker 侧的 bootstrap action;两者解析到同一个 pinned pnpm,产物逐字节一致)。

**构建上下文必须是仓库根,不是 `apps/`** —— `apps/server` 经 `workspace:*` 依赖 `packages/*`,单独的 `apps/` 解析不到。手动构建:

```bash
docker build -f apps/Dockerfile -t bilibili-notify:dev .
```

`apps/docker-compose.example.yaml` 是部署模板。`apps/*` 单独的改动不需要 changeset。
