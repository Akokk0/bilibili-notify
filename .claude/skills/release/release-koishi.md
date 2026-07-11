# 发版:koishi(npm)

**改版本号 + push dev = 发版。** registry 上只有 `koishi-plugin-bilibili-notify` —— 内部包已 private 且被内联进插件产物(见 `docs/agents/build-release.md`),没有版本联动要算,changesets 已弃用。

`publish.yml` 监听 push 到 **dev**,只在 `koishi/package.json` 的 **`version` 字段**变动时才发(`scripts/koishi-version-changed.mjs`)。注意判据是 version **字段**,不是这个文件 —— 它会被 `vp pack` 自动回写 `inlinedDependencies` / `exports`,每次构建都可能刷新。

## 步骤

1. **写 CHANGELOG** — 按 [changelog.md](changelog.md) 写 `koishi/CHANGELOG.md` 的新版本段。基线 = CHANGELOG 顶部那个版本(等同 registry 现值)。⚠️ 这一步含**按端归属判断**:`packages/*` 是两端共享的,改了共享包**不代表 koishi 受影响** —— 必须 grep `koishi/src` 验证它是否真的用到了被改的能力,别把独立端专属的修复写进 koishi 的 CHANGELOG。完成:本批改动都归了端,koishi 该得的都在里面、不该有的一条没有。
2. **定版本** — 版本号**由用户拍板**,不要自己决定。dist-tag 由它**自动推导**:`5.0.0-alpha.9` → npm tag `alpha`;`5.0.0` → `latest`(见 `scripts/publish.mjs` 的 `resolveDistTag`)。完成:用户给了版本号,且高于 registry 上的现值。
3. **确认门** — 把版本号 + dist-tag + CHANGELOG 摘要给用户拍板。完成:用户明确同意。
4. **发版(不可逆)** — 把版本号写进 `koishi/package.json`,连同 CHANGELOG 一起提交并 push dev。`publish.yml` 的 `detect` 认出 version 变动 → `gate`(Biome/build/typecheck/test)→ `node scripts/publish.mjs` 发 npm。完成:publish run 绿。
5. **验证** — `curl -s https://registry.npmjs.org/koishi-plugin-bilibili-notify | jq -r '.["dist-tags"]'` 里目标 tag == 新版本;并确认 provenance(attestations API 返回 `slsa.dev/provenance`,或 publish 日志 `provenance = true`)。完成:版本到位且带 provenance。

**顺序要紧**:CHANGELOG 先写、版本号后改。`version` 是发版扳机 —— 它和 CHANGELOG 在同一个 commit 里 push 出去,漏了 CHANGELOG 就只能补发一版。

## 不可逆点

**dev 上改 version 号并 push,就直接发 npm 了** —— 没有 main 那道中间闸,也没有 Version PR。所以:

- 别在无关改动里顺手动 version。它是发版扳机,不是普通字段。
- push 前必须:版本号已核对、用户已在步骤 3 拍板。
- 发出去的版本撤不回来,只能再发新版修。

## 两道闸,别搞混

- **`koishi-version-changed.mjs`** = 省 CI 的快速门(版本没动就不启动分钟级的门禁)。它**不防重复发布** —— workflow 重跑时 `github.event.before` 还是老的,它会再判一次 changed。
- **`scripts/publish.mjs`** = 真正的安全闸。发布前查 registry,版本已存在就安静跳过,不会把 CI 染红。但它也**不是**发错版本的救生索。
