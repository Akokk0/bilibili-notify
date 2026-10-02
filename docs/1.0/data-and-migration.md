# 1.0 数据代与迁移

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023，以及 ADR-0024 ～ 0031。

数据目录怎么分代、代里放什么、开机怎么迁、回退与重迁、全新开始、旧代清理、图库与素材库、跨代共享的宿主件。文件里装的**形状**见 [data-model.md](./data-model.md)；这份只管文件**放在哪、怎么搬**。

## 一句话

**每次改数据格式的升级，在 `<dataDir>` 下开一个新的「代」，旧代原样留着就是备份。** 开机选「schema ≤ 我」的最新一代，回退不需要还原；「全新开始」就是开一个空代。崩溃恢复只有一套写法。

## 为什么是数据代

三条硬事实限制了能怎么改：

- **桌面壳和 `boot.mjs` 是冻住的**，不随应用内更新替换：载荷目录只能在 `<dataDir>/versions`；桌面壳 30 秒没就绪就杀进程，连续 3 次把这一版判死。
- **自愈会无条件退回镜像 / 安装包自带的版本**：1.0 起不来就跑回 0.12，0.12 必须还能读自己的数据。
- **用户会主动回退**。已发出去的 0.x 之间回退报错这类问题修不了，但 1.0 往后不能再犯。

「写新目录」「迁移前备份」「全新开始挪到一边」原本是三套各管一段的写法，收成一种机制。复用应用内更新现成的版本目录、比版本、保留规则（version-dirs / compareVersions / prune）。代码里把 dataDir 拆成「宿主根」与「数据根」两个名字（⑤ 已落：`apps/server/src/runtime/roots.ts`，`AppRuntime.hostRoot` / `dataRoot`）。宿主根就是 dataDir，boot 与服务端的 `versions/` 都经 `versionsRootIn` → `hostPath`，所以对拍测试钉住 dataDir 的解析就够；「两个根分开以后没有传混」随 ⑥b 补上了：数据根是 `generations/<序号>/`，`apps/server/src/__tests__/boot-generations-e2e.test.ts` 起真服务、迁完跑完关掉，看第 0 代一个字节没变 —— 谁把东西写回宿主根就红。

## 目录布局

```
<dataDir>/
├─ versions/            载荷版本 + boot-state.json + manifest-freshness.json；冻住的 boot.mjs 认这里，不分代
├─ logs/                日志跨代连续；冻住的桌面壳写死了这里，行格式冻结
├─ （0.x 旧文件）       第 0 代：原样不动，只作迁移输入
└─ generations/<序号>/  一代一个目录，序号递增；写到一半的叫 <序号>.partial/
   ├─ generation.json   格式版本、从哪一代迁来、lastActiveAt
   ├─ config/           settings/{core.json, bilibili.json, extensions/<id>.json}  subscriptions.json  connections.json  targets.json
   ├─ secrets/          master.key  kdf.salt  config-secrets.enc
   │                    bilibili/secrets.enc  extensions/<id>/secrets.enc
   │                    （内置平台适配器要存时同样是 <键>/secrets.enc）
   ├─ runtime/          subscription-state.json  roast-drafts.json  card-bg-cursors.json
   │                    bilibili/state.json  extensions/<id>/state.json
   │                    （内置平台适配器要存时同样是 <键>/state.json）
   ├─ history/          <日>.jsonl  repush/<日>/
   ├─ images/           <sha256>.<ext>  统一图库（含聊天附件）
   ├─ stats/            posts/  live/  followers/  seen/  since
   ├─ ai/               conversations/
   ├─ skins/            card/<id>/  panel/<id>/  panel/active.json
   ├─ library/          images/  fonts/  index.json
   ├─ maid-skills/      <name>/SKILL.md
   └─ extensions/       已装拓展包 + load-state.json
```

布局原则：

- **小状态按性质分**：`config/` 放主人填的；`secrets/` 放密钥；`runtime/` 放程序自己记的，丢了只退化。
- **第二层按集成**（ADR-0025 决策 1）：内置集成直接用它的键，B 站就叫 `bilibili/`；拓展在 `extensions/<id>/`；一个集成在 `runtime/` 下一个 `state.json`，在 `secrets/` 下一个 `secrets.enc`。内置平台适配器（OneBot、QQ 官方机器人、webhook）也是集成，要存 `state` / `secrets` 时照 B 站的样子放在 `runtime/<键>/`、`secrets/<键>/`（ADR-0025 决策 9）。不设 `sources/` 这一层：内置集成的键都是保留 id，拓展又一律落在 `extensions/` 下，两边撞不上。
- **大块内容按领域分**：`history/`、`stats/`、`ai/`、`skins/`、`library/`、`images/`、`maid-skills/`、`extensions/`。已装的拓展包跟着代走，回退时拿回旧版拓展。
- **跨代共享的一律冻结格式**。
- 代目录按递增序号起名（ADR-0022 决策 3 下的 🔗）：开新代一律拿下一个号，旧代原地不动、永不改名；选代在「格式版本 ≤ 我」的代里取序号最大的。

## 逐目录

备份是**逻辑导出**（从内存读配置各节，完整备份再把密钥装进 PIN 密钥袋），不是拷目录。「进备份」指内容有没有被导出。

| 位置 | 装什么 | 进备份 | 保留期 | 全新开始 | 迁移 |
| --- | --- | --- | --- | --- | --- |
| `config/` | 设置（core / bilibili / extensions 三类段）、订阅（一个文件）、连接、目标 | 是（各节） | 无 | 清 | 变换：globals 分段、订阅两文件合一、连接与目标换形状 |
| `secrets/master.key` · `kdf.salt` | 主密钥 / 口令派生盐 | 否（本机专用） | 无 | 新生成 | 逐字节拷，两代必须相同，否则彼此密文解不开 |
| `secrets/config-secrets.enc` | AI 各家 apiKey | 仅完整备份 | 无 | 清 | 原样拷 |
| `secrets/bilibili/secrets.enc` | B 站这个集成的 `ctx.secrets`：cookie 罐在 `http.cookies` 键（`http.` 开头的键归宿主），登录用的刷新令牌在 B 站自己的键；每个集成 256KB | 仅完整备份 | 无 | 清 | 由 `cookies.json` 转来；手动从第 0 代重新迁移时，cookie 以第 0 代那份为准（ADR-0022 决策 3 下 10-01 的 🔗） |
| `secrets/extensions/<id>/secrets.enc` | 拓展的 `ctx.secrets`，一个拓展一个文件 | 仅完整备份（普通备份抹掉） | 卸载清 | 清 | 原样拷 |
| `runtime/subscription-state.json` | 资料缓存，按订阅 id；存储叫 `SubscriptionStateStore`。问题表全在内存、不存盘（ADR-0025 决策 11） | 否 | 删订阅即删 | 清 | 变换，见迁移表 |
| `runtime/roast-drafts.json` | 待主人审批的锐评稿 | 否 | 48 小时 | 清 | 变换（老 uid 草稿改订阅 id） |
| `runtime/card-bg-cursors.json` | 直播封面轮换游标 | 否 | 无 | 清 | 从根目录搬进来 |
| `runtime/bilibili/state.json` · `extensions/<id>/state.json` | 集成的 `ctx.state`（`packages/http` 生成的浏览器身份在 `http.` 开头的键里，归宿主）；单键 64KB、每个集成 1MB | 否 | 卸载清 | 清 | B 站那份由 sub-runtime 的 `roomId` / `followed` / `followError` 拆出 |
| `history/` | 推送历史行（`HistoryEntry`）、重推原件（`RepushSnapshot`） | 否 | `core.history.retentionDays`（默认 30） | 清 | 行变换，图换成图库引用；头像快照（0.x 存的是远端地址）丢掉，只留名字 |
| `images/` | 作品图、直播封面、头像、历史快照、聊天附件 | 否 | 按引用清扫 | 清 | 原 `avatars/`、`history/img/`、重推原件的自存图、`assets/chat/` 按 sha256 改名并进来 |
| `stats/` | 作品（`PostEntry`）、直播场次（`LiveSessionEntry`）、粉丝时序、seen（留不留见「迁移步骤」的统计那行）、水位线 | 否 | 无（删订阅才删） | 清 | 变换；追加写的文件一律复制 |
| `ai/` | 女仆对话（附件在图库） | 否 | 对话上限与空会话回收 | 清 | 对话变换（剥皮肤引用、附件 id 换成图库引用） |
| `skins/card/` | 卡片皮肤 | 否 | 无 | 清 | **不迁**，指针回默认 |
| `skins/dashboard/` · `library/` · `maid-skills/` | 界面皮肤、素材、主人的女仆技能 | 否 | 无 | 清 | 拷 / 硬链接；技能 `allowedTools` 按新工具名变换 |
| `extensions/` | 已装拓展包、连败记账 | 否（设置随 config） | 无 | 清 | 拷；devtools 软链重建不拷；v2 拓展列进首访页 |

- 备份里订阅只有一节，备份 schema 抬版。
- 完整备份里的凭据按集成分格 `integrationSecrets`（内容就是各集成的 `ctx.secrets`），恢复回 `restoredIntegrations`；集成自己不导入导出。
- **1.0 之前的备份拒收**：信封改成比自己新、比自己旧的都拒，提示「这是 1.0 之前的备份：先装 0.12 恢复，再升级到 1.0 走迁移」。
- 已知限制（这次不改）：备份只恢复「引用方」。背景图、字体、卡片皮肤不在备份里，恢复到另一台机器后会悬空、回落到默认。

## 开机顺序

1. **先 listen**：起 HTTP，健康检查立刻返回，桌面壳眼里这次开机就算成功——避开它 30 秒的就绪超时与 3 次判死。载荷的启动入口要等第 4 步做完才返回；迁移或起引擎抛错就先关 HTTP 再抛，冻住的 boot.mjs 照旧退回预装的那一版（ADR-0022 决策 2 下的 🔗）。迁移期间其余 `/api` 回 503 `unavailable`，鉴权闸与完整的 app 是同一套。
2. 选代：「格式版本 ≤ 我」里序号最大的一代（见「回退与重迁」）。
3. 需要迁移就**在同一进程全量迁移**。新代先写成 `generations/<序号>.partial`，完成后原子改名；中途被杀，下次开机删掉半截重来。
4. 迁完才起引擎。迁移期间面板显示「正在搬家」进度，**不推送**。

被否的备选：分两段迁（小文件先迁，大块内容 listen 之后接着跑）——同一个文件两头同时写、要写合并逻辑，还有一段「数据不全」的状态。

代价：1.0 第一次开机推送会停一会儿；图多、盘慢时可能几分钟。

## 设置坏了怎么办

**坏了哪一处就只停哪一处，只有解析不了才挡开机**（ADR-0025 决策 4、ADR-0024 决策 9 与 10）。理由：BN 起不来时，桌面壳连续失败几次就把这一版判死、自愈退回 0.12，而且进不去面板改设置；Docker 则反复重启。

| 坏在哪 | 怎么办 |
| --- | --- |
| 文件解析不了（信封坏了） | 挡开机 |
| 设置的拓展段 `extensions.<id>`、`bilibili` 段校验不过 | 只停那一个集成，运行状态记 `settings-invalid`；面板显示原值与原因并进问题框，改对了当场起 |
| 设置的 `core` 段某一格校验不过 | 逐格校验（每个顶层键一格，`defaults` 与 `ai` 再细一层）：坏的那格在内存里用默认值，盘上原文不动，问题表记一条「先按默认值跑」；主人在面板上重存那一格就清掉 |
| 一条连接的 `settings` 不过它的适配器的 `settingsSchema` | 只隔离那一条：不交给适配器、不投递；面板显示「设置不合法」与原因，进问题框；盘上原文不动 |
| 一条连接的外壳（`id` / `name` / `adapterKey` / `platform`）坏了 | 挡开机 |
| 一条目标指向的连接不在了 | 只隔离那一条 |

- 生命周期闸是唯一的例外：只有 `start` / `activate` 期间读设置失败可以抛错中止启动，宿主接住转成 `settings-invalid`；运行中的 `get()` 不抛。
- 撤下的旧连接形状写成明确的名单，不靠猜。
- `core` 某格退回默认时行为会变（过滤、静音、新手引导），靠问题框亮出来。面板登录凭据在 `bn.config.yaml`，不在这些段里，退回默认值不会把门打开。
- 备份是从内存导出的：退回默认的那格、被隔离的连接与目标，备份里带盘上原文还是内存里的值，施工时定。

## 迁移步骤

迁移模块只跑一次：旧格式的知识只住在这里，1.0 的新 schema 不留兼容分支，之后的版本可以整个删掉这个模块。除卡片皮肤外全部迁。

**第 0 步：收编 0.x 兼容代码**，原样跑现有的 0.x 升级链，所以输入可以是任意 0.x 版本。它们大多已是 raw → raw 的纯函数，老测试搬成迁移模块的夹具（约 59 个文件）：各 schema 的 preprocess、`migration.ts`（连接 / 目标 v1 → v2）、`migrateLegacyTargets` 与 `adapters.json`、apiKey 明文迁出、history 读时映射、锐评老 uid 草稿、统计读时翻译、`migrate-file-keys`。

迁移器因此分两遍：先把文件搬进代的布局，再一族一族改写成 0.x 最新的形状，各个 store 开机只认最新的形状。改写写的是新文件（原子换名）：搬过来的文件多半是指向第 0 代的硬链接，原地写会改到第 0 代。顺序有依赖：连接与目标 → 设置 → 订阅 → 推送历史 → 要订阅列表的统计与锐评草稿 → 皮肤、对话、密钥。已收：连接与目标（`migration/connections.ts`；最老单文件 targets 拆出来的连接 id 改成确定的，重迁拆出同一批 id）；推送特性这一组（`migration/features.ts`：附加项的两代老数据、第一代 routing、订阅上的 @全体，照 zod 当年外层先、里层后的顺序跑，由设置与订阅两族的改写调用）；设置里的 AI（扁平连接字段、「一家一桶」、手改的人格，`migration/ai.ts`）、链接解析（0.9.1 的范围 + 白名单，`migration/link-parsing.ts`）、历代旧默认模板（`migration/templates.ts`，原先在配置仓开机时做）。卡片样式退役的 `hideDesc` / `hideFollower` 不迁：schema 不是 strict，读的时候自己剥掉。全新安装的人格指针原先靠 preprocess 每次 parse 补出来，现在直接写在默认值里。推送历史的老行（一行一个目标 × 一条消息，`migration/history.ts`，原先每次读时映射）；统计（`migration/stats.ts`）：B 站的 `<uid>.jsonl` 并进 `<订阅 id>.jsonl`（原先每次开机都并，为的是接住回退后重升；有了代以后回退再升级是重迁一代，迁一次就够），再把老作品行的 B 站类型串、老下播帧的字符串峰值翻成中立的形状（原先每次读时翻；解析不出峰值的那一场照旧当没采到，迁移器把这一场前面记下的峰值一起剥掉）；锐评草稿按 uid 回指的换成订阅 id（`migration/roast-drafts.ts`，原先草稿库读盘时翻）。界面皮肤（`migration/skins.ts`）：`active.json` 的旧单指针 `{id}` 按那套皮肤有的模式落进深浅两槽，清单与出厂快照摘掉 v0.7.0 及之前烙进 css 的两句（皮肤包导入那条路还留着同一把清洁工，外面流传的老皮肤包不是盘上的数据）。女仆对话（`migration/conversations.ts`）：0.x 早期缺的面孔三格（`mode` / `persona` / `skinTarget`）按工具痕迹补齐，认痕迹用的是冻住的 0.x 工具名；会话库从此缺一格就当坏文件跳过。卡片皮肤不迁，会话里对它们的引用（卡片工坊的账本 `cardSkinLedger`、每条回复碰过的皮肤 `cardSkins`）同一步剥掉，正文与工具痕迹保留（ADR-0022 决策 4）。不收进迁移器的：消息版式对齐当前块集、密文解不开当空、schema 的缺键补默认 —— 它们是一直要用的规矩（以后加块、换口令、加设置项都靠它们），不是 0.x 兼容，留在活代码；koishi 时代的 `-key` 模板写法、AI 配置的老键 `enableVision`、OneBot 缺 `transport` 属于 0.x 最新 → 1.0 那次改名迁移，见下表。密钥（`migration/secrets.ts`）：加密袋里 0.x 单把的 `aiApiKey` 并进分桶的 `aiApiKeys.custom`，解袋用第 0 代那把主密钥（口令从开机参数传进迁移），解不开的原样留着；`globals.json` 里的明文 key 抬进加密袋那一步不算兼容，是「盘上不留明文」的长期规矩，留在配置仓，冲突时明文优先（ADR-0022 决策 4 的 🔗）。

**第 1 步：1.0 改名表。**

| 什么 | 怎么迁 |
| --- | --- |
| `state/globals.json` | 拆进 `config/settings/` 的三类文件（`core.json`、`bilibili.json`、`extensions/<id>.json`），按「`defaults` 只是按订阅覆盖的回退层」归位（见 [data-model.md](./data-model.md)「配置」）：`dynamicCron` 进 `bilibili` 段；`userAgent` 由迁移丢掉、新 schema 不留，身份一律由 `packages/http` 生成（ADR-0025 决策 7）；`healthCheckMinutes` → `bilibili.loginCheckIntervalMinutes`；`app` 拆成 `core.logging` / `core.history` / `core.timezone`；`fansCron` 原值 → `core.profileRefreshCron`；`defaults.ai` 的实例桶、搜索、聊天 → `core.ai`，订阅能覆盖的人格预设留 `defaults.ai.presetId`；`templateDefaultsSeen` → `core.templatesSeen`；全局 `roastSchedule` → `core.rankingReport`；`templates.wordcloudStopWords` → `defaults.wordcloud.stopWords`；`schedule` 解散（`quietHours` 进 defaults，`liveEndGrace` 进 `defaults.liveEnd.grace`）；`mutedUntil` → `muteEndsAt`（ISO，为 0 就缺键）；`master.targetId` 指向群目标的清空、首访页提示重选；`accounts.order` 按登记顺序填；拓展的设置进 `extensions/<id>.json`，开关留在 `core.json`。⚠️ 原先写的「`installedAt` 转 ISO」在 globals 里查无此字段，施工时查清指的是什么或删掉 |
| 链接设置 `linkParsing` | `core.linkPreview { enabled, replyForm, byTarget }`（ADR-0029 决策 1）：`defaults.form` → `replyForm`，取值 `miniapp` → `nativeShare`；`groups` → `byTarget`（键仍是目标 id），条目里 `parse` → `enabled`、`form` → `replyForm`。旧的总开关 `enabled` 与默认行的 `defaults.parse` 摊平后怎么并成一个 `enabled`、`cooldownSeconds` 放在哪，施工时定 |
| 特性键 `dynamic` / `atAllDynamic` / `liveGuardBuy`（订阅路由、全局开关、历史） | `post` / `atAllPost` / `membership` |
| 直播拆键 | `routing.live` 复制给 `liveStart` 与 `liveStreaming`；`liveStart` 开关沿用 `live`；`liveStreaming` = 原 `live` 开着且 `pushTime > 0`，间隔用原 `pushTime`；`pushTime` 为 0 的 `liveStreaming` 关、间隔填 1 小时；`restartPush` → `liveStart.catchUpOnBoot`；`atAllLive` → `atAllLiveStart`；`templates.liveOngoing` → `templates.liveStreaming`。每条订阅按合并后的值算，只有和全局不同的才写进 overrides |
| 以特性键 / 卡种 / 附加项 / 模块名做键的配置：`messageLayout.dynamic`（必填键）、`cardStyleByKind` 的 `dynamic` / `sc` / `guard`（裸 object，不迁会被悄悄剥掉）、逐目标 extras 的 `atAllDynamic` / `atAllLive`、`overrides.features.extras`、`app.logLevels` | 按改名对照改键；`cardStyleByKind` → `defaults.cards.byKind`；订阅顶层 `extras` → `extraTargets`；`logLevels` → `core.logging.levels`，`dynamic` / `live` 并成 `bilibili` |
| 文案 `templates.dynamic` / `dynamicVideo`（全局与逐订阅）、`templateDefaultsSeen` | `templates.post` / `postVideo`，值原样搬；账本随模板键换键，等于旧默认指纹的换成新默认指纹 |
| 直播侧 9 条文案（开播 / 直播中 / 下播 3 条、上舰 3 档、特别弹幕、特别进场、弹幕总结）里 koishi 时代的 `-key`；人名变量 `{mname}`（上舰）、`{mastername}`（特别弹幕、特别进场）、`{uname}`；上舰的档名 `{guard}`、弹幕总结的粉丝牌名 `{mdn}` | 按运行期同一套规则（同一组键、最长先匹配）改写成 `{key}`，出字一字不差（现行规则会误伤，如 `real-time` 里的 `-time`，迁移照同一规则改写，出字仍不变）；人名改成 `{name}` / `{name}` / `{viewer}`，`{guard}` → `{tier}`、`{mdn}` → `{fanclub}`（ADR-0028 决策 3），都和 `-key` 同一趟，出来的字不变。**不动**：面板变量列表（`pages/rules/sections.tsx`）只换代码、中文说明不动；弹幕总结的其余缩写 `{dmc}` `{dca}` `{un1..5}` `{dc1..5}` 不动 |
| `templates.guardBuy.{captain,commander,governor}`、`minGuardLevel` | `templates.membership.guard`：`enabled` 取旧 `enable`，`tiers` 取旧三档、key 不变，`default` 留空；`minGuardLevel` → `defaults.membership.minRank.guard`，换算反过来（1 ↔ 3，旧值 1 = 总督） |
| 过滤与阈值：`blockForward` / `blockArticle` / `blockDraw` / `blockAv`、`whitelistKeywords` / `whitelistRegex`、`minScPrice`、特别关注的 uid | `blockReposts` / `blockArticles` / `blockImages` / `blockVideos`、`allowKeywords` / `allowRegex`、`defaults.superchat.minAmount`；特别关注转成 `{ id, note? }` 进公共订阅形状 |
| `imageGroup`（全局与逐订阅） | 形状不变，子键 `forward` → `mergeForward`，`enable` → `enabled` |
| `cardStyle`（`enabled`、`liveCoverImages`、退役的 `font` / `fontAsset` / `glass*`） | `defaults.cards{ enabled, liveCoverImageIds }`，退役字段丢掉 |
| AI 配置 `dynamicPrompt`、`presets[].dynamicPrompt`、`search.engines`、`providers` / `activeProfile`、`activePreset` 与 `overrides.ai.preset`、`enableThinking` + `thinkingLevel`、`enableVision`、顶层 `persona` / 提示词 | `postPrompt`、`presets[].postPrompt`、`search.scenes`（子键 `dynamic` → `post`）、`profiles` / `activeProfileId`、`presetId`、`thinking{ enabled, level }`、`hasVision`；顶层人格与提示词收进 `presets`（必填 / 带默认值：漏迁的话那一格校验不过、整格退回默认，或者悄悄关掉联网搜索，见「设置坏了怎么办」） |
| 订阅两个文件 | 合成 `config/subscriptions.json`，行写成 `identity: { sourceKey, externalId }`（B 站的 uid 就是 externalId）——⑥d 已落（`migration/subscriptions.ts`，拓展那份只作迁移输入）；别名 `name` 丢弃（随 ⑥d 已落，schema 也删了这一格）；指向老卡片皮肤的指针回默认、失效 id 的旋钮删掉、指向内置皮肤的照留 |
| `state/sub-runtime.json` | 改名 `runtime/subscription-state.json`，只剩资料缓存；`roomId` / `followed` / `followError` 搬进 `runtime/bilibili/state.json`；`fansBaseline` 丢弃；缓存资料的 `sign` → `bio`、空串当缺键；0.x 存的远端头像地址 `cachedProfile.avatar` 丢掉、迁移不联网，开机第一轮资料刷新由集成经 `fetchImage` 重新抓成图库引用；拓展订阅存在 `avatars/<订阅 id>` 的头像文件进图库后填成引用。问题表不存盘，没有要迁的（开机时关注同步与第一轮资料刷新几秒内会重报） |
| 密钥 | `master.key` / `kdf.salt` 逐字节拷；`cookies.json` → `secrets/bilibili/secrets.enc`：cookie 罐（`cookiesJson`）进 `http.cookies` 键，`refreshToken` 进 B 站自己的一个键（键名施工时定） |
| bootstrap（`bn.config.yaml`、环境变量、命令行） | 不迁：在用户自己的文件里。`cookieEncryptionKey` / `BN_COOKIE_KEY` / `--cookie-key` 改中立名（新名施工时定），`chromeIdleSeconds` 及其 env / CLI 改 `…Sec`，旧名都永远继续认；`cookieEncryptionKey` 新旧同时设且值不同就拒绝启动；`preset.pushTargets` 读到就忽略。冻住的桌面壳放行的 5 个环境变量、镜像写死的 5 个永不改名 |
| 连接 | 形状换成 `{ id, name, enabled, adapterKey, platform, settings, platformSnapshot, probeState? }`（ADR-0024 决策 7）。`kind`、`connector`、`extensionId` 删掉，改填 `adapterKey`：直连按平台填内置适配器的键（`onebot`、`qq-official`、`webhook`；飞书 / 钉钉 / 企业微信 / 通用四家都填 `webhook`），拓展连接填原 `extensionId`；`platform` 照搬；`config` → `settings`，OneBot 的 `transport` 保留、作 OneBot 适配器私有的设置（删掉的 `connector` 本来就和它重复），0.x 早期没写 `transport` 的 OneBot 连接迁移时写成显式的 `http`（今天靠活 schema 的 `.default("http")`，⑥c 留到这一步一起收），`retryTimes` → `maxRetries`、`forwardMinTimeoutMs` → `mergeForwardMinTimeoutMs`；迁移时填 `platformSnapshot`（`PlatformDescriptor` 去掉 `platform` 那一格）：直连照 0.x 的平台表抄，`tint` 改叫 `color`，`connectors` / `inbound` / `atAll` 不进快照；拓展借来的 bot 的平台不在那张表里，迁移又跑在引擎起来之前、问不到适配器，这一格怎么填施工时定；`testStatus` 不迁移，`probeState` 缺着，开机重探（ADR-0026 决策 5） |
| 目标 | 删 `platform`，平台一律经 `connectionId` 从连接取（ADR-0024 决策 9）；endpoint 目标的 `scope` 丢弃；`testStatus` 改名 `reachability`（`lastCheckedAt` → `changedAt`），旧值不搬，与连接的探测状态同样处理，由下一次投递的结果写回；连接不在了的目标照搬，读盘时只隔离那一条、不挡开机 |
| 历史行（`HistoryEntry`） | 行带 `identity`（取代 `uid` 与 `extensionId` + `externalId` 两套格）；`unameSnapshot` → `nameSnapshot`；`uavatarSnapshot`（远端头像地址）丢掉、迁移不联网，旧行的 `avatarSnapshot` 缺着，只留名字，图缺就画兜底；`ts` → `createdAt`；推送种类那格 `kind` → `feature`，值 `dynamic` → `post`、`live` → `liveStart`、`live-ongoing` → `liveStreaming`、`live-end` → `liveEnd`、`guard` → `membership`、`sc` → `superchat`、`special-danmaku` → `specialDanmaku`、`special-enter` → `specialUserEnter`；消息的 `retryOf` → `repushOf`，`payload.imageRef` 换成图库引用；投递结果里的旧失败（`ok: false` 带 `err` 原话）转成 `{ ok: false, code: "unknown", message: 原话 }`（ADR-0026 决策 5），`latencyMs` 照留，没留原话的 `message` 填什么施工时定；补丁行的 `patch` → `rowId` |
| 重推原件（`RepushSnapshot`，原 `DraftSchema`） | `v` → `version`；每条消息的 `role` 照留，载荷逐种：`text` 照搬。`image` 与 `composite` 里的图（`{ ref, mime, own? }`）按内容摘要进图库，`ref` 换成图库引用；`own`（标「复用历史那份 / 原件自己存的」）删掉：图按摘要进图库、按引用清扫，两处不再有区别。`composite` 的段判别键 `type` → `kind`，`link` / `at-all` 段照搬。`forward-images` → `image-group`：`images[]` 由 `ForwardImage` 换成 `PostImage`（旧的只有 `url`，没有图库引用），`forward` → `mergeForward`。`miniapp-card` → 原生分享（kind 取值施工时定，类型随 `NativeShare…`）：`desc` → `description`、`picUrl` → `imageUrl`、`path` → `pagePath`、`jumpUrl` → `webUrl`，`title` 照搬；旧原件没有 `appId`（旧的全是 B 站小程序卡），迁移怎么补施工时定。链接预览的回复不落历史，盘上照理没有这种原件，schema 里有就照样给去向 |
| 图：`history/img/`、`avatars/`、重推原件的自存图、`assets/chat/` | 都进代内 `images/`，按 sha256 改名后硬链接到旧文件；历史行、重推原件、资料缓存、AI 会话里的引用同步换成摘要 |
| 统计与粉丝 | `stats/dyn` → `stats/posts`，行叫 `PostEntry`（`video` → `post` + `hasVideo`，老的 `type: DYNAMIC_TYPE_*` 行同样改写，开播公告行不搬）；根目录 `fans/` → `stats/followers`；`<uid>.jsonl` → `<订阅 id>.jsonl`；直播帧 `{ k, ts, peak }` → `{ kind, occurredAt, peakTotalViewers }`，peak 的「1.2万」转精确数；场次行叫 `LiveSessionEntry`，`peakViewers` → `peakTotalViewers`；粉丝样本 `value` → `followers`；`ts` → `publishedAt` / `sampledAt`；旧日子的「在记」按旧规则推：作品看那天有没有旧记录，直播用现在的直播开关近似（ADR-0027 决策 3）；热力图也读「在记」，seen 不再单独当判据，所以不再从老粉丝样本补 seen；每天的开关与运行状态怎么记、`seen/` 留不留，施工时定 |
| AI 对话 | `ai/chat` → `ai/conversations`；`assets/chat` 的附件按内容摘要搬进图库 `images/`，会话里的附件 id 改写成图库引用（ADR-0030 决策 2）；消息上的卡片皮肤引用去掉、对话文字全部保留；皮肤账本（`CardSkinLedger`）清空 |
| 女仆技能 | `maid-skills` 拷、`allowedTools` 按新工具名变换。内置技能 `find-up` → `find-creator`、`up-pk` → `creator-pk`，旧名留别名（ADR-0030 决策 1）；内置技能写在代码里、不在盘上，迁移不用改写。主人自己建过同名的 `find-creator` / `creator-pk`，改名后会被内置的顶掉，怎么处理施工时定 |
| 皮肤、素材、拓展 | 卡片皮肤不迁；`skins/` → `skins/dashboard/` 原样拷；`assets/card-bg`、`assets/font` → `library/images`、`library/fonts`；`extensions/` 拷、devtools 软链重建、v2 拓展列进首访页。皮肤字段 `membership.text` → `membership.announcement`（ADR-0028 决策 4）只动 1.0 的字段表：卡片皮肤不迁、老包拒收，盘上没有要改写的 |
| 遗留物：`state/adapters.json`、`*.json.bak`、`*.restore.bak`、`*.tmp.*`、`.staging-*`、`*.migrating`、storage 默认路径 `bilibili-notify/` | 只作输入读一次或丢弃，不进新代 |

**链接与复制**：迁移时任何链接失败都回落复制（不只是跨分区）。追加写的 jsonl 一律复制、不做硬链接——否则新版往里追加会改到旧代的文件。

**守卫**（守卫 13）：以 FeatureKey / CardKind / ExtraKey 做键的记录全部钉进迁移清单；重推原件 `RepushSnapshot` 的每种载荷 kind 与每个字段都要有去向；全仓对数据根的 `join(dataDir, …)` 前缀都必须在上面的目录表里。漏一个就红。后半已落：代码里的目录表（`runtime/roots.ts` 的 `DATA_ROOT_LAYOUT`）登记的是代的布局（⑥b 起），0.x 的布局（`ZERO_GENERATION_LAYOUT`）搬进了迁移模块、只作输入；迁移器每一项的去向都引用各个仓自己导出的位置（`CONFIG_DIR`、`FOLLOWERS_DIR`……），`satisfies` 钉住 0.x 的每一项都有去向；前缀由 `dataPath` 的类型守，`apps/server/src/__tests__/data-roots.test.ts` 钉住没人绕开它自己拼、配置键 `dataDir` 只在边界上出现、宿主表的 `logs` 与桌面壳写死的那处对得上。另有一条迁移耗时测试（⑨，`apps/server/src/migration/__tests__/migration-timing.test.ts`，合成数据在同目录的 `synthetic-zero.ts`）：满量是 40 个 B 站订阅 + 4 个拓展订阅留满 365 天（推送历史每天 120 条、每条一张图，粉丝每 10 分钟一个点，约 4.6 万个文件、240 万行、267 MB），四分之一量是 10 + 1 个订阅、历史 91 天（每一块会涨的东西都严格 1/4）；满量照 0.x 的最坏情况摆（0.x 的保留天数最多 365、文字和图一起留）；判据见 ADR-0022 决策 4 下的 🔗。默认跳过，`vpr test:migration-timing` 与 CI 的专门作业才跑。

### 首访询问页

主人迁移后第一次打开面板时弹一页：

- 说明旧数据已经迁好、老卡片皮肤要重新生成、旧数据留着当备份；
- 列出「因契约版本不收」的拓展，给一键更新；
- 主人目标原先指向群目标的，迁移时已清空，提示重选（ADR-0021 决策 57）；
- 问要不要「全新开始」。

🔗 ⑧ 落地（10-02）：数据走一张通用的提示清单 `SystemNotice`（`GET /api/system/notices`，看过的 `POST /api/system/notices/:id/acknowledge`），存在用着的那一代的 `generation.json` 的 `notices` 里，换一代就是一张新清单。今天三种：`migrated`（从第 0 代迁出的每一代都有一条，`cardSkinsDropped` 说老卡片皮肤没迁；3a 加主人目标已清空）、`generation-failed`（主人要求的新代没开成，原因原话）、`rolled-back`（启动器判死的、比正在跑的新的版本，那一版后来起来了就不再给）。「因契约版本不收」的拓展不进清单，面板从 `/api/ext` 现查。全新开始与从旧代重新迁移共用 `POST /api/system/generations`（`{ source: "empty" | "zero" }`）：先判拉不拉得起来、第 0 代在不在，再在 `generations/pending.json` 写一次性标记、回话、重启；开机取出标记就删。全新开始把主密钥带过去（不登出）；要求的新代没开成就留在原来那一代、原因进清单，迁移已经开始的话正常退出等着被拉起，没人拉才抛。页面本身随第 4 期出稿。

## 回退与重迁

**只迁一次，之后各代互不干涉**（ADR-0022 决策 3 下 10-01 的 🔗）。

- 新版只认格式版本与自己对得上的那一代，盘上有就直接用，没有才从能迁的旧代迁（今天只有第 0 代）。
- 回退到旧版：旧版用它自己那一代（0.x 读第 0 代），新版在回退前产生的数据不带过去。
- 再升回来：新版照用自己那一代，回退期间旧版产生的数据留在旧代。
- 要以旧代为准：系统页「从旧代重新迁移」，开下一个号的新代，当前代原地留着当备份，和全新开始同一条路。确认框写明当前这段数据不带过去、B 站登录以旧代那份为准。
- 每代 `generation.json` 的 `lastActiveAt` 在开机用到这一代时更新，只给系统页显示「最后使用时间」，不拿来判断。
- 自愈退回：新版起不来、被启动器判死退回时，面板据 `boot-state.json` 的判死名单（`failed`）说「X 起不来，已退回 Y」；退回的目标是 0.x 时说不出来，0.x 的面板改不了。启动器不另记开机史。

被否的备选：

- 谁最后在用，就以谁为准（原定）：要给第 0 代记指纹、开机比对。全量记的话每次开机要 lstat 上千个文件，误判一次就把当前代扔掉；只看设置与密钥又会漏判。
- 只提示、不动手的小指纹；启动器另记开机史：都只是事后告知，后者只覆盖重新下载了新启动器的人。
- 两代合并：订阅、历史、统计要各写一套合并规则，还有两边都改过同一份数据的冲突。

**开发期的重迁**（09-30 定）：1.0 开发期每一期都在改盘上格式、往迁移模块里加条目，格式版本却一直是 1。所以每一代再记一个**迁移修订号**（`MIGRATION_REVISION`，在迁移模块里）：开发期每改一次迁移的产出就加 1，只比一样不一样。当前代的修订号和代码对不上，就照它当初的来源重开一代（第 0 代迁来的从第 0 代重迁，空代就再开空代），开下一个号、旧代原地留着 —— 和「从旧代重新迁移」同一条开新代的路。开发期在新代里产生的数据因此带不过来。迁移测试对一棵夹具树算产出摘要，产出变了、修订号没抬就红。修订号在 alpha.1 冻住；alpha 之间要是还改盘上格式，是「格式版本加 1、从上一代迁」还是继续从第 0 代重迁（测试者在 alpha 期间的数据会丢），发 alpha 前定。

**0.x → 1.0 这一次**：旧文件一个都不改、不删，它本身就是第 0 代。1.0 连续起不来时自愈会无条件退回自带的那版，主人点回退也会回到 0.x；两种情况下 0.x 读到的都是自己原来的文件。已知限制：「0.12 退回 0.11 报错」这类问题，已发出的 0.x 修不了。

## 全新开始

- 开一个空代：B 站重扫、token 与 AI key 重填、回新手引导；各集成的 `ctx.state` 与 `ctx.secrets` 一并清空。
- **不碰 `bn.config.yaml` 与环境变量**，面板账号保留。理由：面板账号只在 bootstrap 配置或环境变量里；清掉的话监听 0.0.0.0 的 Docker 会拒绝启动，环境变量里的账号也根本清不掉。
- 被否的备选：用环境变量控制迁移——自动更新的 Docker 不会有人去设。
- 被否的备选：只清内容、保留接入（B 站登录、推送连接、AI key）——主人选了像新装一样全清；面板账号保留只是因为它在 bootstrap 里、清不掉（Q49）。

## 旧代清理

**不自动删**，旧代就是备份，删备份得主人点头。

| 代 | 规矩 |
| --- | --- |
| 当前代 | 永远留 |
| 上一代 | 默认留，迁移满 30 天才许清 |
| 更早的 | 列为「可清理」 |
| 第 0 代 | 按写死的白名单删；`versions/`、`logs/` 永不碰 |

系统页「旧版本数据」显示每代的版本、最后使用时间、大小与清理按钮；确认框写明清后回退不到那个版本。代价：磁盘会涨，直到主人手动清。

## 图库

- 所有图按内容摘要存成 `images/<sha256>.<ext>`：作品图、直播封面、头像、历史快照、聊天附件都引用它。取消 `runtime/avatars/` 与 `history/img/`，也不给聊天附件另开目录。
- 集成的入口只有两个：`ctx.fetchImage`（走集成自己的请求客户端，同一套 cookie、身份与默认头；拦内网地址且每一跳重定向都查、单张 8MB、嗅探格式、超时）与 `ctx.storeImage`（手里已是字节的，同一套嗅探与 8MB）；两者都返回结果形状、不抛错（ADR-0025 决策 8、10）；上报一律只收 `ImageRef`。
- 聊天附件经面板上传进图库，不进素材库；上传仍是单张 5MB、每条 4 张、拒 SVG；会话里存 `ImageRef`（ADR-0030 决策 2）。
- 清扫：保留期清理那一趟按引用全局清扫，引用方含历史行、重推原件、资料缓存、AI 会话。
- 🔗 10-02：历史拆成两层，文字不设上限、图按图片保留天数清（90 / 60 / 30 / 15 / 7 / 3 / 1，默认 30），清扫只数保留期以内的历史行与重推原件，新图留约一天宽限期，引用方登记成表配守卫；迁移时换算老配置、不搬超期的图与孤儿图。全文见 ADR-0022 决策 9 下的 🔗。
- 出图器只内联引用、不联网；面板一律走同源地址；AI 看图也读图库，由宿主注入读图函数，`packages/ai` 不碰磁盘。

## 素材库与皮肤

- **素材库 `library/`** 只收主人主动上传、反复挑选的图与字体（卡片旋钮、直播封面）。接口 `/api/library` + 通用素材选择器，**删前查引用**。女仆做皮肤、界面皮肤、拓展选图以后再接进来。
- 对话附件进图库（见上节），皮肤包自带的资产留在包内——它们随对话或皮肤包一起生死，进素材库只会塞满一次性的东西。素材库与皮肤包资产共用一份资产存储实现 `createAssetStore`（参数：目录、id 取法随机或 sha256、允许的格式、大小上限）。
- **皮肤**：卡片与界面皮肤合目录（`skins/card/`、`skins/dashboard/`）、合存储代码（`createSkinStore<清单>`），不合概念——清单、「用哪套」的指针、渲染各走各的。

## 持久化底层与关停

所有存储都收到三件东西上，挂在已有的件上、不另开一套：

1. **原子写**（新建，家在 `packages/storage`，叫 `atomicWriteJson`；现在是服务端三份逐字相同的私有副本，另有约 8 种各写各的临时文件写法）：临时文件统一命名，写完 fsync 文件与目录，失败删临时文件，可选文件权限；读到坏文件先改名成 `.corrupt-<时刻>` 隔离（配置文件解析不了仍挡开机，见「设置坏了怎么办」）；开机清掉上个进程留下的临时文件。服务端 `update/durable-json.ts`（`select-version-for-boot`、`manifest-freshness`、`extensions/load-ledger`、`extensions/marketplace` 在用）已并进来（第 1 期切片 ②）：它留作四处共用的「两头都吞掉失败」策略层，底下改用 storage 的同步原语，读到坏文件改名隔离、仍当没记过，写失败仍只回调不抛；导出改名 `readBestEffortJson` / `writeBestEffortJson`，不再和 storage 的 `readJsonFile` 同名（守卫 4）。
2. **写道** = `createSerialQueue`（新建，家在 internal 的零依赖子路径；现在只有面板里一个小的，服务端至少 11 处手写 `prev.then` 队列）带 `flush` 与关门：按键串行，支持单一全局键（历史的全局串行是刻意的）；关门后的写入直接拒绝、不碰盘。
3. **后台任务登记** = ServiceContext 加 `track(promise)` 与分阶段的 onDispose：「发出去不管」的写入改成登记在案、能被取消。

原语已落（第 1 期切片 ①，切片 ② 补齐，见 [construction-plan.md](./construction-plan.md)）：`packages/storage` 导出 `atomicWriteFile` / `atomicWriteJson` 及同步版（临时名 `<目标>.bn-tmp.<pid>.<随机>`，fsync 文件与目录，Windows 与不支持目录 fsync 的文件系统（部分 NAS / SMB / FUSE 挂载）跳过目录那一步；同步版给开机早期的选版与装载账本）、`readJsonFile` 及同步版（结果分 `ok` / `missing` / `corrupt`，坏文件改名 `.corrupt-<ISO 时刻>`）、`appendLines` / `appendJsonl`（不 fsync，读方要容得下末尾半行；日志自己序列化，走 `appendLines`）、`replaceDirectory`（换下来的旧目录叫 `.bn-old.*`；暂存与旧目录名可指定，`versions/` 与拓展装载根沿用点开头的老名字，因为已发出去的代码与装载器按它们认残留）、`removeDirectory`（先改成临时名再删）、`isLeftoverName`（扫目录建索引时跳过原语的残留）、`sweepTempFiles`（只认这两种标记；Docker 里 pid 常常相同，所以必须在任何写入之前跑；读不动或清不掉的地方只跳过那一处、记进报告；已接在服务端启动最早处、`createAppRuntime` 之前，跳过的地方记一行 warn、不挡开机）；internal 导出 `createSerialQueue`（`run(key, task)`、`flush`、`close`，关门后拒绝，错误码 `queue_closed`）。fsync 本身没法用不崩溃的夹具验证（残余风险）。

关停顺序（服务端预算 8 秒，给桌面壳与 Docker 默认的 10 秒留余量；compose 样例写上 `stop_grace_period`）：

```
停生产者（来源 · 拓展 · 定时）→ HTTP 排空（2–3 秒）→ 等后台任务 → 统计补下播帧 → 各写道 flush 并关门 → 其余收尾
```

已落（第 1 期切片 ③）：各部件装配时把收尾登记进 ServiceContext 的四段 `DisposePhase`（`stop` / `drain` / `flush` / `dispose`），`track()` 登记的后台活在 `drain` 与 `flush` 之间等齐；统计补下播帧与写道同在 `flush` 段（统计只写它自己那条队）。HTTP 排空最多占预算的 30%，到点强断；`flush` 之前的等待至少给它留 25%；预算用完就不再等，但剩下的钩子照样调用，写道总有机会关门。皮肤与资产原名清单两条写道是模块级、同一进程里的所有 store 共用，只 flush 不关门。服务端的代码层面怎么接见 `docs/agents/architecture.md`「关停」。

顺带修掉：cookie、会话、card-bg-cursors、字体清单不是原子写；审批草稿「先删后发」在关停时会丢；日志关停时刷不干净；对话附件孤儿泄漏（附件进图库、按引用清扫后自然消失）；恢复备份的事务不完整（cookie 在回滚范围外、崩溃后不回收 `.restore.bak`、overwrite 会不可逆地级联删掉统计 / 粉丝 / 头像）。

守卫：服务端除了持久化底层不许直接写文件；服务关停返回以后数据目录不再变化。

**正常关停的通知路**：外壳起服务端时把 stdin 接成管道、退出时关掉它，服务端听到 stdin 关闭走和 SIGTERM 同一套收尾，超时硬杀不变。只在外壳设了开关变量（如 `BN_STDIN_SHUTDOWN=1`）时才听，和 `BN_PARENT_PID` 同一个做法。开关不能省：Docker 不带 `-i`、systemd、nohup 下 stdin 是 `/dev/null`，不设开关的话一开机就读到结尾、把自己关掉。SIGTERM 留给 Docker 和直接运行；外壳崩了管道也会断，和 `BN_PARENT_PID` 的孤儿自检互为兜底。两者并进由 `runtime/parent-watch.ts` 扩成的「宿主看护」模块。现状：Windows 上桌面壳的 `terminate_child` 直接 `child.kill()`，服务端的收尾一次也没跑过；壳是冻住的，老安装包这条修不了。这套托管规矩写进托管文档，桌面版和以后的插件照同一份。注意：桌面壳不随应用内更新替换，只对重装了新安装包的用户生效。

## 宿主件与冻结格式

| 件 | 位置 | 为什么不分代 | 冻结什么 |
| --- | --- | --- | --- |
| 载荷版本 | `versions/<semver>/` | 冻住的 `boot.mjs` 从 dataDir 推算这里 | 目录布局 |
| 选版状态 | `versions/boot-state.json`、`versions/manifest-freshness.json` | 同上 | 文件格式 |
| 日志 | `logs/<日>.jsonl` | 冻住的桌面壳写死了这里；日志要跨代连续 | 行格式（`msg`、`ts`…）不改名，否则回退后显示错乱 |

- 日志落盘前按当前全部密钥的实际值脱敏（`ctx.secrets` 值里的每一段字符串，很短的不遮；`secret: true` 字段；各集成用 `ctx.redact` 登记的临时凭据）；写死的 cookie 名正则删掉；集成名（`bilibili` 或拓展 id）在已有的 `name` 字段里。
- `docs/agents/self-update.md` 在收尾期（第 5 期，见 [construction-plan.md](./construction-plan.md)）补写数据代、开机顺序、回退后再升级，以及 0.x → 1.0 这一次旧文件保持原样。
