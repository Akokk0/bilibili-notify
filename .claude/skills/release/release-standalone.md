# 发版:独立端(Docker + Desktop + npm)

源码内版本恒为 `0.0.0-dev`,**git tag `v<VERSION>` 是唯一发布事实源** —— CI 构建前由 `.github/scripts/shared/sync-app-version.sh` 按 tag 临时同步版本元数据。tag 触发四条**互不阻塞**的 workflow:`image-release.yml`(Docker)、`desktop-release.yml`(Desktop)、`npm-release.yml`(npm成品)与 `update-payload.yml`(应用内更新载荷)。机制见 `docs/agents/build-release.md`。

四条都以 `gate`(`gate.yml`,仓库门禁的唯一定义:Biome + build + typecheck + test)开头,**门禁不绿就不构建、不推镜像、不出安装包、不发npm**。注意 `assert-release-ref-on-dev.sh` **不是**门禁 —— 它只保证 tag 指向的 commit 在 dev 上,不保证它是绿的。

## 步骤

1. **起草 CHANGELOG** — 按 [changelog.md](changelog.md) 起草 `apps/CHANGELOG.md` 的新版本段,版本号先空着。基线 = 最新的 `v*` tag(`git tag -l 'v*' --sort=-creatordate | head -1`)。正式版跟在 alpha 之后、以及本轮新功能的修补要不要写,都按 changelog.md 里的规矩来。⚠️ 这一步含**用户感知判断**:改了 `packages/*` **不代表独立端用户感知得到** —— 得去 `apps/` 里确认用到了被改的那部分(见 changelog.md 的「`packages/*` 改了 ≠ 用户感知得到」)。
2. **拍板** — 版本号**由用户拍板**,不要自己决定。prerelease(如 `0.2.0-alpha.1`)→ Docker `:alpha` / npm `alpha`;纯 semver(如 `0.2.0`)→ `latest`。版本号、渠道和CHANGELOG摘要一次给用户确认；npm首发及可信发布配置按构建发行指引准备，不从本地夹具推断账号权限。
3. **定稿并提交** — 填上版本标题,跑 `vp exec node scripts/changelog-section.mjs --version <VERSION>` 验概述(概述会被签进更新清单、念在通知卡上,找不到 / 为空 / 超 120 字发版时直接红),提交;用户同意后 push 到 dev(tag 要指向含 CHANGELOG 的那个 commit)。
4. **打 tag(不可逆)** — 在 `dev` HEAD(即含 CHANGELOG 那个 commit)创建并推送 annotated tag `v<VERSION>`。可本地打,或用 `version-tag` workflow dry_run=false。完成:tag 已 push 且可从 `origin/dev` 到达。
5. **验证产物** — `image-release`、`desktop-release`、`npm-release`、`update-payload` 四条 workflow 各自触发且绿(都从 `gate` 起步,门禁红了后面的 job 直接不跑);Docker 镜像渠道 tag(`:alpha`/`:latest` + `:vX.Y.Z` + `:<sha>`,及各自的 `-slim`)到位、可拉取;渠道清单里 `notes` 是 CHANGELOG 概述、GitHub Release 正文开头是 CHANGELOG 整段。npm上版本与宿主tag一致、alpha/latest不回退，真实安装后的web/dev可启动。完成:四workflow绿、镜像可拉、npm成品可用，清单与发布页都带着CHANGELOG。

**顺序要紧**:CHANGELOG 先写、先 push,再打 tag:发布页正文和更新清单的 notes 都从 tag 所指 commit 的 CHANGELOG 抽,缺了会红。

## dry-run 预检(默认跳过)

默认不跑。用户点名,或本版动过 `build:desktop` / `build:update-payload` / `build:bn-package` / npm发行流程 / `prepare-resources` 时,`version-tag`、`image-release`、`desktop-release`、`npm-release`、`update-payload` 各跑一次 dry_run=true,全绿再打 tag。

## 发错了

推`v<VERSION>`tag即触发发行。npm同名同版本一经发布不能复用，即使删除包也不能重发同号；已进入任一不可变渠道时，改发新版本，必要时按现有机制撤回坏更新。只有所有渠道尚未产生不可变产物时，才核对现场后考虑重建tag。

npm中断时先重跑失败的publish作业，复用原Actions候选；同版本内容一致会跳过上传，冲突会拒绝覆盖。不要通过重新构建、改字节再重打同号绕过校验。首次包建立及可信发布的具体准备见[构建发行指引的npm一节](../../../docs/agents/build-release.md#npm成品包)。
