# 发版:独立端(Docker + Desktop + npm)

源码版本保持 `0.0.0-dev`。发布版本由 `v<VERSION>` tag 决定。tag 触发 `npm-release.yml`，同一次全量门禁通过后，Docker、桌面、npm 和应用内更新并行发布。[构建与发布参考](../../../docs/agents/build-release.md)

## 步骤

1. **起草 CHANGELOG** — 按 [changelog.md](changelog.md) 起草 `apps/CHANGELOG.md` 的新版本段,版本号先空着。基线 = 最新的 `v*` tag(`git tag -l 'v*' --sort=-creatordate | head -1`)。正式版跟在 alpha 之后、以及本轮新功能的修补要不要写,都按 changelog.md 里的规矩来。⚠️ 这一步含**用户感知判断**:改了 `packages/*` **不代表独立端用户感知得到** —— 得去 `apps/` 里确认用到了被改的那部分(见 changelog.md 的「`packages/*` 改了 ≠ 用户感知得到」)。
2. **核对决定** — 版本号由用户拍板；已明确的版本、渠道和发行授权直接沿用。prerelease(如 `0.2.0-alpha.1`)→ Docker `:alpha` / npm `alpha`;纯 semver(如 `0.2.0`)→ `latest`。需要确认时提供已准备的版本、渠道和 CHANGELOG 摘要；npm首发及可信发布配置按构建发行指引准备，不从本地夹具推断账号权限。
3. **定稿并提交** — 填上版本标题,跑 `vp exec node scripts/changelog-section.mjs --version <VERSION>` 验概述(概述会被签进更新清单、念在通知卡上,找不到 / 为空 / 超 120 字发版时直接红),提交;用户同意后 push 到 dev(tag 要指向含 CHANGELOG 的那个 commit)。
4. **推送发行 tag** — 在 `dev` HEAD(即含 CHANGELOG 那个 commit)创建并推送 annotated tag `v<VERSION>`。可本地打,或用 `version-tag` workflow dry_run=false。完成:tag 已 push 且可从 `origin/dev` 到达。
5. **验证产物** — 确认 `npm-release.yml` 的门禁及四种产物均通过。Docker 验渠道、版本、提交 tag 及各自的 `-slim` 可拉取。确认桌面安装包已上传。核对应用内清单的版本、签名、载荷摘要和 CHANGELOG 概述，以及发布页正文开头的 CHANGELOG 整段。核对 npm 版本、渠道和构建摘要，从公开仓库安装后启动 `bn web` 和 `bn dev`。
6. 按共享流程[合并发布快照](SKILL.md#合并发布快照)，完成本次发版。

**顺序要紧**:CHANGELOG 先写、先 push,再打 tag:发布页正文和更新清单的 notes 都从 tag 所指 commit 的 CHANGELOG 抽,缺了会红。

## dry-run 预检(默认跳过)

用户点名预检，或本版改动本体发行工作流、载荷装配、桌面资源准备或 npm 打包时，在 `dev` 运行 `version-tag.yml` 和 `npm-release.yml`，传相同的 `version` 和 `dry_run=true`。核对两项运行都指向待发提交，并在通过后打 tag。

## 发错了

推`v<VERSION>`tag即触发发行。npm同名同版本一经发布不能复用，即使删除包也不能重发同号；已进入任一不可变渠道时，改发新版本，必要时按现有机制撤回坏更新。只有所有渠道尚未产生不可变产物时，才核对现场后考虑重建tag。

npm中断时先重跑失败的publish作业，复用原Actions候选；同版本内容一致会跳过上传，冲突会拒绝覆盖。不要通过重新构建、改字节再重打同号绕过校验。首次包建立及可信发布的具体准备见[构建发行指引的npm一节](../../../docs/agents/build-release.md#npm成品包)。
