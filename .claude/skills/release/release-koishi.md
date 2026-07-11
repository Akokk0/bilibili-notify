# 发版:koishi(npm)

**一个包、一次 push**。registry 上只有 `koishi-plugin-bilibili-notify` —— 内部包已 private 且被内联进插件产物(见 `docs/agents/build-release.md`),所以没有版本联动要算,changesets 已弃用。发版 = 手改版本号 + 合进 main。

## 步骤

1. **定版本** — 编辑 `koishi/package.json` 的 `version`。dist-tag 由它**自动推导**:`5.0.0-alpha.9` → npm tag `alpha`;`5.0.0` → `latest`(见 `scripts/publish.mjs` 的 `resolveDistTag`)。完成:版本号已改且高于 registry 上的现值。
2. **写 CHANGELOG** — 手写 `koishi/CHANGELOG.md` 新版本段(changesets 不再自动生成)。完成:本次要发的改动都在里面。
3. **确认门** — 把版本号 + dist-tag + CHANGELOG 摘要给用户拍板。完成:用户明确同意。
4. **发版(不可逆)** — 提交上面两处改动到 dev,然后 `git checkout main && git merge --no-ff dev -m "chore: sync dev to main"` 并 push main。`publish.yml` 跑 lint/build/typecheck/test,再执行 `node scripts/publish.mjs` 发 npm。完成:publish run 绿。
5. **验证** — `curl -s https://registry.npmjs.org/koishi-plugin-bilibili-notify | jq -r '.["dist-tags"]'` 里目标 tag == 新版本;并确认 provenance(attestations API 返回 `slsa.dev/provenance`,或 publish 日志 `provenance = true`)。完成:版本到位且带 provenance。
6. **回流** — `git checkout dev && git merge --ff-only origin/main && git push origin dev`。完成:`origin/dev` == `origin/main`(同一 sha)。

## 不可逆点

push main 会直接触发 npm publish(没有 Version PR 那道中间闸了)—— **push 前必须**:版本号已核对、用户已在步骤 3 拍板。

publish 是**幂等**的:`scripts/publish.mjs` 发布前查 registry,版本已存在就安静跳过。所以因为别的原因 push main(合并 bug 修复等)不会误发,也不会把 CI 染红 —— 但这**不是**发错版本的救生索,发出去的版本撤不回来,只能再发新版修。
