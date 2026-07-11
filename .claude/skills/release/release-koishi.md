# 发版:koishi(npm)

**改版本号 + push dev = 发版。** registry 上只有 `koishi-plugin-bilibili-notify` —— 内部包已 private 且被内联进插件产物(见 `docs/agents/build-release.md`),没有版本联动要算,changesets 已弃用。

`publish.yml` 监听 push 到 **dev**,只在 `koishi/package.json` 的 **`version` 字段**变动时才发(`scripts/koishi-version-changed.mjs`)。注意判据是 version **字段**,不是这个文件 —— 它会被 `vp pack` 自动回写 `inlinedDependencies` / `exports`,每次构建都可能刷新。

## 步骤

1. **定版本** — 编辑 `koishi/package.json` 的 `version`。dist-tag 由它**自动推导**:`5.0.0-alpha.9` → npm tag `alpha`;`5.0.0` → `latest`(见 `scripts/publish.mjs` 的 `resolveDistTag`)。完成:版本号已改且高于 registry 上的现值。
2. **写 CHANGELOG** — 手写 `koishi/CHANGELOG.md` 新版本段(changesets 不再自动生成)。完成:本次要发的改动都在里面。
3. **确认门** — 把版本号 + dist-tag + CHANGELOG 摘要给用户拍板。完成:用户明确同意。
4. **发版(不可逆)** — 提交上面两处改动并 push dev。`publish.yml` 跑 lint/build/typecheck/test,再执行 `node scripts/publish.mjs` 发 npm。完成:publish run 绿。
5. **验证** — `curl -s https://registry.npmjs.org/koishi-plugin-bilibili-notify | jq -r '.["dist-tags"]'` 里目标 tag == 新版本;并确认 provenance(attestations API 返回 `slsa.dev/provenance`,或 publish 日志 `provenance = true`)。完成:版本到位且带 provenance。

## 不可逆点

**dev 上改 version 号并 push,就直接发 npm 了** —— 没有 main 那道中间闸,也没有 Version PR。所以:

- 别在无关改动里顺手动 version。它是发版扳机,不是普通字段。
- push 前必须:版本号已核对、用户已在步骤 3 拍板。
- 发出去的版本撤不回来,只能再发新版修。

## 两道闸,别搞混

- **`koishi-version-changed.mjs`** = 省 CI 的快速门(版本没动就不启动分钟级的门禁)。它**不防重复发布** —— workflow 重跑时 `github.event.before` 还是老的,它会再判一次 changed。
- **`scripts/publish.mjs`** = 真正的安全闸。发布前查 registry,版本已存在就安静跳过,不会把 CI 染红。但它也**不是**发错版本的救生索。
