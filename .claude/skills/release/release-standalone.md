# 发版:独立端(Docker + Desktop)

源码内版本恒为 `0.0.0-dev`,**git tag `v<VERSION>` 是唯一发布事实源** —— CI 构建前由 `sync-standalone-version.sh` 按 tag 临时同步版本元数据。tag 触发两个**互不阻塞**的 workflow:`image-release.yml`(Docker)与 `desktop-release.yml`(Desktop)。机制见 `docs/agents/build-release.md`。

## 步骤

1. **dry-run 预检** — 正式打 tag 前手动跑:`version-tag`(version=`<V>`, dry_run=true)校验 tag 格式与现有 tag 兼容;`image-release` 与 `desktop-release` 各跑 dry_run=true(构建但不 push / 不建 Release)。完成:三个 dry-run 都绿。
2. **打 tag** — 在 `dev` HEAD 创建并推送 annotated tag `v<VERSION>`(prerelease 如 `v0.1.0-alpha.12` → Docker `:alpha`;纯 semver 如 `v0.1.0` → `:latest`)。可本地打,或用 `version-tag` workflow dry_run=false。完成:tag 已 push 且可从 `origin/dev` 到达。
3. **验证产物** — `image-release` 与 `desktop-release` 两 workflow 各自触发且绿;Docker 镜像渠道 tag(`:alpha`/`:latest` + `:vX.Y.Z` + `:<sha>`)到位、可拉取。完成:两 workflow 绿、镜像可拉。
4. **Desktop 实机确认(不可自动化)** — dry-run 的 CI smoke 不是完整 GUI E2E。正式 tag 后仍需在 Windows 实机确认:托盘图标、无控制台窗口、NSIS 安装启动、退出后无残留 sidecar。完成:Windows 实机清单逐项过。

## 不可逆点

推送 `v<VERSION>` tag 即触发发布 workflow,Docker 镜像与 GitHub Release 一旦 push 不能撤回、只能发新版本 tag 覆盖。打 tag 前务必走完步骤 1 的 dry-run。`dev→main` 合并**不**触发独立端;独立端发版与 koishi npm 发版互不牵动。
