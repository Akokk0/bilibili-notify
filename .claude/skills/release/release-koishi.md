# 发版:koishi(npm)

changesets **两阶段**(sync → version PR → publish)+ 收尾**回流**。机制(为什么两阶段、为什么回流是 fast-forward 且不冲突)见 `docs/agents/build-release.md`;本清单只管**按序执行 + 在不可逆点确认**。

## 步骤

1. **预演** — 临时分支 merge dev→main,跑 `vp exec changeset version` 看实际会 bump 哪些包 / 版本(pre 模式自动跳过 `pre.json` 已消费的"幽灵"changeset),记下清单,再 `git reset --hard` + 删临时分支。完成:得到逐包版本清单,且与 `vp exec changeset status --since=origin/main`(我方本次新增)对得上。
2. **确认门** — 把**完整**清单给用户拍板:发版会连带 main 上**所有** pending changeset(不止本次改动),changesets 无法只发其中一部分。完成:用户明确同意发布范围。
3. **sync** — `git checkout main && git merge --no-ff dev -m "chore: sync dev to main"`,push main。完成:`publish.yml` run 绿,且 changesets action 把 Version PR(`changeset-release/main`)更新成预演的完整清单。
4. **发版(不可逆)** — 核对 Version PR 里每个 `package.json#version` == 预演清单;一致才 `gh pr merge <n> --merge`。合并再次 push main → 无 pending → 触发 `pnpm publish` 发 npm。完成:第二次 publish run 绿、无新 OPEN 的 `changeset-release` PR。
5. **验证** — npm registry 抽查每个包:`curl -s https://registry.npmjs.org/<pkg> | jq -r '.["dist-tags"].alpha'`(scoped 包名里 `/` 编码成 `%2F`)== 预期版本;并确认 provenance(attestations API 返回 `slsa.dev/provenance`,或 publish 日志 `provenance = true`)。完成:每个包 alpha 版本到位且带 provenance。
6. **回流(勿漏)** — `git checkout dev && git merge --ff-only origin/main && git push origin dev`,让 dev 拿到 version bump / CHANGELOG / `pre.json`。完成:`origin/dev` == `origin/main`(同一 sha)。

## 不可逆点

push main、合并 Version PR、`pnpm publish` 都是对外操作,出错不能撤回、只能再发新版修。**步骤 4 合并 Version PR = 真正 npm publish** —— 合并前必须:版本清单已核对一致 + 用户已在步骤 2 拍板范围。步骤 3 的 push main 只更新 Version PR、不发 npm,是安全中间态。
