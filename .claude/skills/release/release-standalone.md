# 发版:独立端(Docker + Desktop)

源码内版本恒为 `0.0.0-dev`,**git tag `v<VERSION>` 是唯一发布事实源** —— CI 构建前由 `sync-standalone-version.sh` 按 tag 临时同步版本元数据。tag 触发两个**互不阻塞**的 workflow:`image-release.yml`(Docker)与 `desktop-release.yml`(Desktop)。机制见 `docs/agents/build-release.md`。

两个 workflow 都以 `gate`(`gate.yml`,仓库门禁的唯一定义:Biome + build + typecheck + test + Python)开头,**门禁不绿就不构建、不推镜像、不出安装包**。注意 `assert-release-ref-on-dev.sh` **不是**门禁 —— 它只保证 tag 指向的 commit 在 dev 上,不保证它是绿的。

## 步骤

1. **写 CHANGELOG** — 按 [changelog.md](changelog.md) 写 `apps/CHANGELOG.md` 的新版本段。基线 = 最新的 `v*` tag(`git tag -l 'v*' --sort=-creatordate | head -1`)。正式版跟在 alpha 之后、以及本轮新功能的修补要不要写,都按 changelog.md 里的规矩来。⚠️ 这一步含**按端归属判断**:`packages/*` 是两端共享的,改了共享包**不代表独立端受影响**,反过来也一样 —— 别把 koishi 专属的变更写进独立端的 CHANGELOG。**提交并 push 到 dev**(tag 要指向含 CHANGELOG 的那个 commit)。完成:本批改动都归了端,独立端该得的都在里面。
2. **定版本** — 版本号**由用户拍板**,不要自己决定。prerelease(如 `0.2.0-alpha.1`)→ Docker `:alpha`;纯 semver(如 `0.2.0`)→ `:latest`。完成:用户给了版本号。
3. **确认门** — 版本号 + Docker 渠道 tag + CHANGELOG 摘要给用户拍板。完成:用户明确同意。
4. **打 tag(不可逆)** — 在 `dev` HEAD(即含 CHANGELOG 那个 commit)创建并推送 annotated tag `v<VERSION>`。可本地打,或用 `version-tag` workflow dry_run=false。完成:tag 已 push 且可从 `origin/dev` 到达。
5. **验证产物** — `image-release` 与 `desktop-release` 两 workflow 各自触发且绿(两条都从 `gate` 起步,门禁红了后面的 job 直接不跑);Docker 镜像渠道 tag(`:alpha`/`:latest` + `:vX.Y.Z` + `:<sha>`)到位、可拉取。完成:两 workflow 绿、镜像可拉。

**顺序要紧**:CHANGELOG 先写、先 push,再打 tag。tag 是发版扳机,它得指向**已经含有 CHANGELOG 的那个 commit** —— 否则发出去的镜像对应不上任何版本说明,而 tag 撤不回来。

## dry-run 预检(仅用户点名才跑,默认跳过)

默认流程**不跑** dry-run,直接打 tag。仅当用户明确要求预检时才跑:`version-tag`(version=`<V>`, dry_run=true)校验 tag 格式与现有 tag 兼容;`image-release` 与 `desktop-release` 各跑 dry_run=true(构建但不 push / 不建 Release);三个都绿后再打 tag。

## 不可逆点

推送 `v<VERSION>` tag 即触发发布 workflow,Docker 镜像与 GitHub Release 一旦 push 不能撤回、只能发新版本 tag 覆盖。(门禁只挡「代码是红的」,挡不住「发错版本」。)独立端发版与 koishi npm 发版互不牵动 —— 后者由 `koishi/package.json` 的 `version` 变动 + push dev 触发。
