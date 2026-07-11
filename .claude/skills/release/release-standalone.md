# 发版:独立端(Docker + Desktop)

源码内版本恒为 `0.0.0-dev`,**git tag `v<VERSION>` 是唯一发布事实源** —— CI 构建前由 `sync-standalone-version.sh` 按 tag 临时同步版本元数据。tag 触发两个**互不阻塞**的 workflow:`image-release.yml`(Docker)与 `desktop-release.yml`(Desktop)。机制见 `docs/agents/build-release.md`。

两个 workflow 都以 `gate`(`gate.yml`,仓库门禁的唯一定义:Biome + build + typecheck + test + Python)开头,**门禁不绿就不构建、不推镜像、不出安装包**。注意 `assert-release-ref-on-dev.sh` **不是**门禁 —— 它只保证 tag 指向的 commit 在 dev 上,不保证它是绿的。

## 步骤

1. **打 tag** — 在 `dev` HEAD 创建并推送 annotated tag `v<VERSION>`(prerelease 如 `v0.1.0-alpha.12` → Docker `:alpha`;纯 semver 如 `v0.1.0` → `:latest`)。可本地打,或用 `version-tag` workflow dry_run=false。完成:tag 已 push 且可从 `origin/dev` 到达。
2. **验证产物** — `image-release` 与 `desktop-release` 两 workflow 各自触发且绿(两条都从 `gate` 起步,门禁红了后面的 job 直接不跑);Docker 镜像渠道 tag(`:alpha`/`:latest` + `:vX.Y.Z` + `:<sha>`)到位、可拉取。完成:两 workflow 绿、镜像可拉。
3. **Desktop 实机确认(不可自动化)** — CI smoke 不是完整 GUI E2E。正式 tag 后仍需在 Windows 实机确认:托盘图标、无控制台窗口、NSIS 安装启动、退出后无残留 sidecar。完成:Windows 实机清单逐项过。

## dry-run 预检(仅用户点名才跑,默认跳过)

默认流程**不跑** dry-run,直接打 tag。仅当用户明确要求预检时才跑:`version-tag`(version=`<V>`, dry_run=true)校验 tag 格式与现有 tag 兼容;`image-release` 与 `desktop-release` 各跑 dry_run=true(构建但不 push / 不建 Release);三个都绿后再打 tag。

## 不可逆点

推送 `v<VERSION>` tag 即触发发布 workflow,Docker 镜像与 GitHub Release 一旦 push 不能撤回、只能发新版本 tag 覆盖。(门禁只挡「代码是红的」,挡不住「发错版本」。)独立端发版与 koishi npm 发版互不牵动 —— 后者由 `koishi/package.json` 的 `version` 变动 + push dev 触发。
