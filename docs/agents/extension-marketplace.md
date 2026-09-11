# 拓展市场

定案见 ADR-0013。这里是「怎么用」:索引长什么样、官方的怎么发、第三方怎么自己开一个源。

## 两种源,一个 schema

| | 官方源 | 第三方源 |
|---|---|---|
| 地址 | 内置:`https://github.com/Akokk0/bilibili-notify/releases/download/extension-marketplace/marketplace.json` | 主人在拓展页「源」里加的任意 `https://` 地址 |
| 文件 | 签名信封 `{ "manifest": "<索引原文>", "signature": "<base64>" }`,与升级清单同一对 Ed25519 密钥 | 裸的索引 JSON |
| 走镜像 | 走(`update.mirrors`,同本体) | 不走 |
| 新鲜度 | `issuedAt` 只增不减,记在 `<dataDir>/extensions/.marketplace.json` | 不查 |
| id | 不带命名空间(`bridge`) | 必须是 `<namespace>.<名字>`,且索引要声明 `namespace` |
| 装之前 | 一键 | 先确认一次 |

索引本体(`packages/internal/src/schema/extension-marketplace.ts` 是唯一定义):

```jsonc
{
  "name": "alice 的拓展",          // 面板上「来自 ○○」
  "namespace": "alice",            // 第三方必填;官方没有
  "owner": { "name": "alice", "url": "https://…" },   // 可选
  "issuedAt": 1760000000,          // 官方必填(epoch 秒);第三方可省
  "revoked": ["alice.douyin@0.9.0"],                  // 可选:撤回的 id@version
  "extensions": [
    {
      "id": "alice.douyin",
      "name": "抖音订阅",
      "description": "一句话",
      "version": "1.0.0",          // semver;每个 id 只列最新那一版
      "apiVersion": 1,             // 对上 BN 的 EXTENSION_API_VERSION 才能装
      "prerelease": false,         // 可选:true 只在 BN 是预发布渠道时显示
      "package": { "url": "https://…/douyin-1.0.0.zip", "sha256": "<64 位小写 hex>", "size": 123456 },
      "releaseUrl": "https://…",   // 可选
      "notes": "这一版改了什么"     // 可选,卡上那一小行
    }
  ]
}
```

不认识的字段丢掉不拒(老客户端要读得了带新字段的索引)。

## 官方的怎么发

1. 改 `extensions/<id>/extension.json` 的 `version`,在 `extensions/<id>/CHANGELOG.md` 加 `## [x.y.z] — 日期` 一段,标题下第一段是概述(≤ 120 字,会进索引的 `notes`)。
2. 提交、push 到 dev。
3. 打 tag `ext/<id>@x.y.z` 并 push。`extension-release.yml` 会:门禁 → 核对 tag 与清单版本 → `vp run -F @bilibili-notify/extension-<id> build` → `scripts/pack-extension.mjs` 打包(只装 `extension.json` + `index.mjs`,固定时间戳,sha256 可复现)→ 建同名 release、挂 zip → 拉当前索引、并进这一条(`scripts/marketplace-index.mjs`)→ 用 `BN_UPDATE_SIGNING_KEY` 签 → 覆盖到 `extension-marketplace` release 的 `marketplace.json`。
4. 手动 dry-run:Actions 里跑 `extension release`,填 id 与 version,`dry_run` 勾着 —— 构建、打包、签索引都跑,只不上传。

撤回一版:暂时手动 —— 拿当前索引本体跑 `node scripts/marketplace-index.mjs --entry <最新那条> --current current.json --revoke <id>@<版本>`,再用 `publish-extension-marketplace.sh` 发。（撤回 workflow 是后话。）

## 第三方怎么开一个源

作者要做的只有两件事,任何 https 静态托管都行(GitHub Release / Pages / 对象存储):

1. 把拓展包(`vp pack` 出来的 `dist/`,打成只含 `extension.json` + `index.mjs` 的 zip)放到一个 https 地址,算出 sha256 与字节数。清单里的 `id` 必须是 `<你的命名空间>.<名字>`。
2. 放一份 `marketplace.json`(上面那个形状,`namespace` 写你的命名空间),`package.url` 指向那个 zip。

用户在 BN 拓展页 →「源」→ 填名字与 `marketplace.json` 的地址。BN 不审核源里的东西,装之前会再提醒一次。同一个命名空间在一台 BN 上只能由一个源占;想冒充官方(列一个不带点的 id)整个源会被拒。

## 装了之后

- `<dataDir>/extensions/.marketplace.json` 记着每个 id 从哪个源装的哪一版;「有新版」只认原来源。手放的 / devtools 链的没有记录,不提示更新。
- 更新 = 从市场再装一次;盖掉一份正在跑的要重启一次(同上传装包)。
- 契约不合(`apiVersion` 对不上)的条目标灰「先升级 BN」;撤回的标红。

## 代码位置

| 哪 | 干什么 |
|---|---|
| `packages/internal/src/schema/extension-marketplace.ts` | 索引 schema、两种源的规矩(`checkMarketplaceIndex`)、撤回判据 |
| `apps/server/src/extensions/marketplace.ts` | 拉索引(官方走 `fetchSignedJson`,第三方走 `fetchThroughMirrors` 直连)、算状态、下载校验落盘、来源记录 |
| `apps/server/src/routes/extensions.ts` | `GET /api/ext/marketplace`(`?refresh=1` 无视缓存)、`POST /api/ext/marketplace/install` |
| `apps/web/src/pages/extensions/marketplace-section.tsx` / `marketplace-sources-dialog.tsx` | 那一节与「源」弹窗 |
| `scripts/pack-extension.mjs` / `scripts/marketplace-index.mjs` | 发版侧:打包、并索引、签 |
| `.github/workflows/extension-release.yml` | tag 触发的整条流水线 |
