# 拓展市场

定案见 ADR-0013。这里是「怎么用」:索引长什么样、官方的怎么发、第三方怎么自己开一个源。

## 两种源,一个 schema

| | 官方源 | 第三方源 |
|---|---|---|
| 地址 | 内置:`https://github.com/Akokk0/bilibili-notify/releases/download/extensions/marketplace.json`(滚动 release `extensions`;旧的 `extension-marketplace` 是 0.12 读的,已冻结,见下「发布与地址」) | 主人在拓展页「源」里加的任意 `https://` 地址 |
| 文件 | 签名信封 `{ "manifest": "<索引原文>", "signature": "<base64>" }`,与升级清单同一对 Ed25519 密钥 | 裸的索引 JSON |
| 走镜像 | 走(`update.mirrors`,同本体) | 不走 |
| 新鲜度 | `issuedAt` 只增不减,记在 `<数据根>/extensions/.marketplace.json` | 不查 |
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
      "version": "1.0.0",          // semver(不收 `+build` 元数据);每个 id 每档、每个契约版本只列最新那一版
      "apiVersion": 2,             // 落在 BN 的 EXTENSION_API_RANGE 区间里才能装
      "apiRevision": 0,            // 可选,缺省 0:要的契约小号(抄清单里那格),比 BN 的高也装不了(ADR-0019 决策 59)
      "prerelease": false,         // 可选:true 的那条是预发布档,只有预发布渠道挑得到;必须与版本号对得上(带 - 的才标 true)
      "package": { "url": "https://…/douyin-1.0.0.zip", "sha256": "<64 位小写 hex>", "size": 123456 },
      "releaseUrl": "https://…",   // 可选
      "notes": "这一版改了什么"     // 可选,卡上那一小行
    }
  ]
}
```

不认识的字段丢掉不拒(老客户端要读得了带新字段的索引)。

**给人看的字不分语言**(3b,主人定):索引里的 `name` / `description` / `notes` 只放清单里的默认文字,装上之后才按当前语言显示。第一个带译文的拓展上架时,给条目加一格可选的按语言文字(索引规则不严格,加一格是加宽)。

## 发布与地址

官方索引换过一次地址(3b-04),只换了索引,格式没动:

- 新版 BN 读滚动 release **`extensions`** 上的 `marketplace.json`,用 1.0 的新规矩:每个契约版本各留一条,BN 只在自己装得了的里头挑最高的。客户端的地址常量是 `apps/server/src/update/trusted-keys.ts` 的 `EXTENSION_MARKETPLACE_URL`,发版两个脚本里的 release 名由 `scripts/__tests__/extension-marketplace-release.test.mjs` 钉着和它一致。
- 旧 release `extension-marketplace` 上那份是 0.12 读的,从此不动:0.12 的校验遇到同 id 同档两条会整份拒收,它的选版也不看装不装得了,所以放宽后的索引只能放在新地址上,旧文件保持旧形状。
- **新 release 不播种**:旧索引里全是契约第 1 版的条目,新版 BN 不收,拷过去没有用。`extensions` 第一次出现是在下一个真正的 `extension/<id>@<ver>` tag 发版的时候;在那之前新版 BN 的官方源显示「拿不到」。
- 格式不顺手改:`issuedAt` 仍是秒(进门换 ISO 照 data-model 那条),`apiVersion` / `apiRevision` 不改名。

**同一个 id 每个契约版本最多两条:一条正式 + 一条预发布**(同 id 同档同契约版本两条 → 整份索引拒;契约只有一个版本时就是最多两条)。契约升档的过渡期里,旧 BN 只装得了旧契约的版本、新 BN 只装得了新契约的,所以两个契约版本的最新版同时留着。两档分开是因为打一个 alpha tag 不该让稳定渠道的人**看不见这个拓展** —— 整条被 alpha 顶掉的话,市场上那张卡对他们就消失了,已经装着的还会被标成「从别处装的」。面板上**仍然只出一张卡**:先在这台 BN 装得了的条目里挑(一条都装不了才退回全部里最高的那条,画一张「先升级 BN」的灰卡),稳定渠道拿正式那条(没有正式档就一张都不出),预发布渠道在两档里取**版本更高**的那条(第三方源可能留着一条比正式版还旧的预发布)。挑出来的那一条是这张卡的全部依据 —— 版本、状态、「有新版」、按下去装哪个包。

## 官方的怎么发

1. 改 `extensions/<id>/extension.json` 的 `version`,在 `extensions/<id>/CHANGELOG.md` 加 `## [x.y.z] — 日期` 一段,标题下第一段是概述(≤ 120 字,会进索引的 `notes`)。
2. 提交、push 到 dev。
3. 打 tag `extension/<id>@x.y.z` 并 push。`extension-release.yml` 会:门禁 → 核对 tag 与清单版本 → `vp run -F @bilibili-notify/extension-<id> build` → `scripts/pack-extension.mjs` 打包(必装 `extension.json` + `index.mjs`,另收可选的 `README.md` / `CHANGELOG.md` 与 `locales/<语言码>.json`,固定时间戳,sha256 可复现)→ 建同名 release、挂 zip → 拉当前索引(`.github/scripts/extension-release/fetch-marketplace-index.sh`)、并进这一条(`scripts/marketplace-index.mjs`)→ 用 `BN_UPDATE_SIGNING_KEY` 签 → 覆盖到 `extensions` release 的 `marketplace.json`。

   并索引这一步上钉着三条「只许往前走」,踩了当场红而不是发出一份坏索引:**只有滚动 release 还不存在**才算第一次发(5xx / 限流 / token 权限掉了一律红 —— 当成「还没有索引」会把整份索引连 `revoked` 名单一起覆盖成只含这一条);`issuedAt` 必须比当前那份大(不传就取 `max(现在, 当前 + 1)`,手传的不够大就红),误传毫秒(≥ `1e11`)拒 —— 发出去会把客户端永久钉死在这一份上;**同 id 同档同契约版本**的版本不许降回去(重跑旧 tag),**等于**放行(重发同一版),预发布比同 id 同契约版本的正式档还旧也拒(发进去也没人看得见)。并进一个正式版时,同契约版本里比它旧的预发布档会**一并删掉**;比它新的(下一轮的 alpha)留着;别的契约版本的条目一概不碰。
4. 手动 dry-run:Actions 里跑 `extension release`,填 id 与 version,`dry_run` 勾着 —— 构建、打包、签索引都跑,只不上传。

撤回一版:暂时手动 —— 拿当前索引本体跑 `node scripts/marketplace-index.mjs --entry <最新那条> --current current.json --revoke <id>@<版本>`,再用 `publish-extension-marketplace.sh` 发。（撤回 workflow 是后话。）

## 第三方怎么开一个源

作者要做的只有两件事,任何 https 静态托管都行(GitHub Release / Pages / 对象存储):

1. 把拓展包(`vp pack` 出来的 `dist/`,打成 zip:必须含 `extension.json` + `index.mjs`,**建议带上 `README.md` 与 `CHANGELOG.md`**,各 ≤ 512KB —— BN 会把它们画在拓展详情页上,不带就是一页没有说明;带译文时包里也要有 `locales/<语言码>.json`)放到一个 https 地址,算出 sha256 与字节数。清单里的 `id` 必须是 `<你的命名空间>.<名字>`。除这些之外的文件装载那头一律拒收。
2. 放一份 `marketplace.json`(上面那个形状,`namespace` 写你的命名空间),`package.url` 指向那个 zip。

用户在 BN 拓展页 →「源」→ 填 `marketplace.json` 的地址(名字不用起,索引自己带)。BN 不审核源里的东西,装之前会再提醒一次。同一个命名空间在一台 BN 上只能由一个源占;想冒充官方(列一个不带点的 id)整个源会被拒。

## 装了之后

- `<数据根>/extensions/.marketplace.json` 记着每个 id 从哪个源装的哪一版、官方索引见过的最大 `issuedAt`,以及**每个源上次报的命名空间**(`namespaces`)。「有新版」只认原来源;手放的 / devtools 链的没有记录,不提示更新。
- 命名空间的占位是**记在盘上**的:拉索引之前就按配置顺序占好,先配的源这一趟超时也不会让后配的源抢走它的命名空间(那个源装着的拓展 id 全在那底下)。源删掉了占位才还回去。
- 更新 = 从市场再装一次;盖掉一份正在跑的要重启一次(同上传装包)。「有新版」按**这个渠道挑出来的那一条**算:稳定渠道装着正式版,不会被索引里那条预发布顶成「有新版」。
- 契约不合(`apiVersion` 对不上,或 `apiRevision` 比 BN 的契约小号高)的条目标灰「先升级 BN」;撤回的标红。**索引里那个新版自己装不了的(被撤回 / 要更高一格的契约)不画「有新版」** —— 画出来的钮就得按得动。
- 装着那版被撤回、而索引里有能装的新版:状态照「有新版」给(`updatable`,`installed.revoked` 标着),列表页的已装卡上**红字与「更新」钮一起画**(详情页没有更新钮) —— 那正是最该更新的时候。换不过去才落到「撤回」那一档。
- 下载上限按索引写的 `size` 收;`size` 本身超过本机上限(10 MB)时直接说是上限,不报「下不下来」。
- **卸载**是 `DELETE /api/ext/:id`(`apps/server/src/routes/extensions.ts`):还有连接指着它就不删;然后抹盘(连同重扫)、清它的上报出入、删它的开关与设置文件、清它存的状态与密钥。**保留名字的文件夹是例外**(`RESERVED_EXTENSION_IDS`:`bilibili`、三个内置适配器的键、`core`、`image`、`ai`):这样的文件夹过不了 id 校验、装载不了,面板上是一张「读不了」的卡,卸载时**只抹拓展目录下那一个文件夹**,查连接、清上报出入、删开关与设置、清状态与密钥这几步一步不走 —— 那几步按 id 找到的是同名的内置集成与核心自己的东西(内置适配器的连接、同名内置集成的设置与存着的登录凭据),一个从没跑起来过的拓展本来也没有那些(主人 10-12 定,3a-40 留着的「删不掉的卡」)。

## 代码位置

| 哪 | 干什么 |
|---|---|
| `packages/internal/src/schema/extension-marketplace.ts` | 索引 schema、两种源的规矩(`checkMarketplaceIndex`)、撤回判据 |
| `apps/server/src/extensions/marketplace.ts` | 拉索引(官方走 `fetchSignedJson`,第三方走 `fetchThroughMirrors` 直连)、算状态、下载校验落盘、来源记录 |
| `apps/server/src/routes/extensions.ts` | `GET /api/ext/marketplace`(`?refresh=1` 无视缓存)、`POST /api/ext/marketplace/install` |
| `apps/web/src/pages/extensions/marketplace-section.tsx` / `marketplace-sources-dialog.tsx` | 那一节与「源」弹窗 |
| `scripts/pack-extension.mjs` / `scripts/marketplace-index.mjs` | 发版侧:打包、并索引、签 |
| `.github/workflows/extension-release.yml` | tag 触发的整条流水线 |
