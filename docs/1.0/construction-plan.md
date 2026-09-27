# 1.0 施工计划

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023。

分几期、每期做什么、期间守什么规矩、第 1 期怎么切片、分支怎么走、alpha 怎么发，以及还没进表的零碎施工项。要做成什么样见 [architecture.md](./architecture.md)、[data-model.md](./data-model.md)、[data-and-migration.md](./data-and-migration.md)、[subscription-sources.md](./subscription-sources.md)、[extension-contract.md](./extension-contract.md)、[push.md](./push.md)。

## 一句话

**在 `dev-next` 上一期一期做，每期全量门禁全绿才进下一期；先发 1.0 alpha，稳定后升到 1.0.0。**

## 纪律

- 每一片跑完整门禁再提交。
- 每期（3a、3b 分开算）全量门禁全绿才进下一期。
- 3a 完成即检查点：B 站全经中立接口运行、行为不变；守卫 21「中立性对拍」绿。
- 中立性守卫的归期（09-27 拍板）：守卫 12 在第 1 期切片 ⑥（设置分段落地即守住）；守卫 1、17、21 在 3a（`bilibili/` 在 3a 才出现）；守卫 11 在 3a 开头以棘轮开启——记下当时的命中数当上限，只许少不许多，多一处就红，上限随清理调低，3b 结束必须是 0（不能「一开就红」：每期都得全绿才出期）。
- 哪一期改了盘上形状，就在同一期往迁移模块加条目、钉进守卫 13 的清单；不留到最后统一补。第 1 期只建迁移地基。
- 新写或重写的代码直接用新名，第 5 期只清扫没被动到的旧名。

## 分期

规模以「④′ 轮」计（④′：约 5 小时、26 个提交、116 个文件）。原估 12–14 轮，第二轮拷问加了数据代、接口拆分与命名批，总量施工时重估，不含真机验收。

| 期 | 做什么 | 方式 | 出期条件 | 规模（④′ 轮） |
| --- | --- | --- | --- | --- |
| 0 ✅ | 测试拦外网（守卫 2，`scripts/network-guard.mjs`） | 改造 | 已落 | 0.2 |
| 1 | 地基：身份、持久化底层与关停、资产与皮肤存储合一；**迁移地基**（数据代、先 listen 再迁、回退指纹、首访页、全新开始、订阅合一、设置分段）；迁移耗时测试。切片 ①–⑨ 见下 | 持久化局部重写，其余改造 | 迁移耗时测试绿 | 施工时重估 |
| 2 | 数据模型：作品卡与直播卡、抓图核心服务（安全防护 + 图库）与图库引用、皮肤字段、特性键；新类型直接用新名。并入：`LiveCardInput` 人数只收精确数；`formatCount` 带符号变体、`formatAgo`、`formatDuration`（连删 `{time}` 兜底与 `getTimeDifference` 钩子）；卡种中文名收一份 | 出卡前半段局部重写 | B 站动态出图逐字节不变（守卫 10） | 约 4 |
| 3a | 接口先行：`SubscriptionSource` 与横切接口、登记表、`SourceContext`（state / secrets / report / fetchImage 挂上 ctx）；B 站四个包搬进 `bilibili/` 并实现，中立部分同时拆进 `posts/` 与 `live/`；`accounts/` 与 `bilibili/auth/`；禁 fs 守卫（17）、边界守卫（1）、中立性对拍（21）、B 站词守卫（11，棘轮开启）；schema 标 `secret: true`、服务端按 `MaskedSecret` 下发 | 改造 | 检查点：B 站全经中立接口运行、行为不变 | 施工时重估 |
| 3b | 各块中立化：先 e2e 钉直播四种行为，把醒目留言 / 会员 / 特别弹幕 / 特别进场的装配从 `room-session.ts` 抽进 `live/`，再合场次引擎；直播监听的唯一判定；B 站改存 `WATCHED_CHANGE` 的 `num`；资料刷新、seen、链接卡、指令、AI 工具与女仆技能；DevtoolsProvider 与假桥搬家；拓展契约 v3、`pickPerId` 与索引规则；桥迁 v3 | 链接卡与指令重写，其余改造 | — | 施工时重估 |
| 4 | 面板：按 descriptor 渲染、账号排序、预览、问题框、日志筛选、密钥打码（统一密钥输入框）、素材库界面、旧版本数据清理界面；首页改用直播监听的唯一判定 | — | — | 施工时重估 |
| 5 | 收尾：清扫剩余旧名、目录与文件名、测试归位、死代码、守卫补齐、托管文档与 docs/agents 同步；全仓包版本统一 `0.0.0-dev` | 机械活，一次做完 | — | 约 2 |
| 6 | alpha 配套：抖音拓展；重议 Q76（`linkResolver` / `commands` / `aiTools` 对拓展开不开）；定桥的版本号；在 dev 上打 `v1.0.0-alpha.1` | — | — | 施工时重估 |

- 「方式」沿用最初分期表的施工指引：原第 3 期拆成 3a / 3b，链接卡与指令都在 3b；第 4、6 期没有对应的记录。
- 这些归期是 09-27 复核时补的，主人可调：第 2 期并入的格式函数与直播人数；3a 的中立部分同步拆分与密钥下发；3b 的装配抽出、监听判定与 `num`；第 4 期的首页判定与密钥输入框；第 5 期的包版本；以及下面「零碎施工项」整张表。

## 第 1 期：地基与迁移地基

| 片 | 做什么 | 状态 |
| --- | --- | --- |
| ① | storage / internal 的持久化原语（见 data-and-migration「持久化底层与关停」） | ✅ 已落 |
| ② | 守卫 3 先红；29 个直接写盘的文件迁上原语；`createAssetStore` / `createSkinStore` 合一 | |
| ③ | ServiceContext `track()` + 分阶段 dispose + 8 秒关停 + 守卫 8 | |
| ④ | 契约骨架：统一错误体 `{ code, message }` / `{ ok: false, code, message }`（`upstreamCode` 装平台数字码，现 `routes/subs.ts` 两处改掉）+ WS 事件表（载荷一律具名对象、类型从总线事件表推导）；面板 `errorMessage` 收成只认一种；契约做实的其余部分随它走 | |
| ⑤ | 宿主根 / 数据根拆分 + 目录表（守卫 13 后半） | |
| ⑥ | 数据代、`.partial`、先 listen 再迁、第 0 步收编 0.x 升级链、订阅合一 + `Identity`、设置分段、身份唯一闸 + 守卫 9、守卫 12 | |
| ⑦ | 回退指纹与重迁 | |
| ⑧ | 全新开始 + 首访页 API + 拒收 1.0 之前的备份 | |
| ⑨ | 迁移耗时测试（365 天合成数据） | |

- 契约骨架归第 1 期切片 ④（主人 09-27 拍板）；错误体的防撞规矩见 [architecture.md](./architecture.md)。
- 契约做实的其余部分随契约骨架走（moduleVersions 删 api / dynamic / live 要等这几个包在 3a 删掉，那一小项留到 3a）：`/api/health` 补进契约、moduleVersions 删掉 api / dynamic / live、面板把 contract 移进 `dependencies`。

### 切片 ② / ③ 的验收清单

第 1 期盘点出来的现状，不是主人逐条拍的；做完逐条确认修掉。另见 data-and-migration「持久化底层与关停」的「顺带修掉」。

② 写盘：

- 29 个非测试文件、151 处直接写盘，全部迁上原语。
- 不是原子写的重要文件：cookie、AI 会话、card-bg 游标、字体清单（另有读改写不加锁）、资产字节、repush 草稿、stats since、两个皮肤库直写在用目录的资产。
- 固定名 `.tmp` 并发互踩：key-manager、两个皮肤库、maid-skills。
- `update/durable-json.ts` 并进原语时注意：`boot.ts` 直接 import `select-version-for-boot`（它用 durable-json），所以这次改动会打进新载荷与新镜像里的选版代码；`boot-state.json` / `manifest-freshness.json` 在宿主根、格式冻结，改的只能是写法，不许动文件格式与位置。
- `bn.config.yaml` 两处写（`config/loader.ts` 的 `writeFileAtomic`，写首启动的种文件与迁移后的用户文件；`config/persist.ts`）也走原子写底层。守卫 3 的白名单只放 `config/persist.ts`，它可以改用 storage 的 `atomicWriteFile`（原子写字节，不碰 YAML 注释）；`loader.ts` 那处写进 ② 的迁移名单。

③ 关停：

- HTTP 排空排在第 9 步；顺序改成 data-and-migration「持久化底层与关停」那一条。
- 一个 try 包住全程，任一步抛错后面全跳（含 stats 收尾）。
- 没有总时限。
- 第二次 Ctrl-C 直接杀。
- 关停期日志 hook 被还原成 `undefined`。
- `api.stop` 不加 `refreshGeneration`。

## 分支与发 alpha

1. v0.12.0 之后的开发在 `dev-next`，1.0 在这上面做；`ci.yml` 已加上 dev-next。
2. dev 与 main 同步，只收小修。
3. dev 每有小修就合进 dev-next，保证 dev 始终是 dev-next 的祖先。
4. 发 alpha 时把 dev 快进到 dev-next，在 dev 上打 `v1.0.0-alpha.1`（发版流水线要求 tag 在 dev 上），全程不用 force。

代价：dev 上的每个小修都要往 dev-next 合一次；换来的是改造期间随时能从 dev 发 0.12.x 急修，不会连带发出 1.0 的活。

CLAUDE.md 与 `docs/agents/build-release.md` 的「分支」都还没提 dev-next，随第 5 期同步。

## alpha 之后、1.0.0 之前

| 项 | 怎么做 |
| --- | --- |
| 桥帧改名（09-27 拍板；alpha 不动）：`forward` → `mergeForward`、`desc` → `description`、`picUrl` → `imageUrl`、能力名 `forward` 同改、能力名 `miniapp-card` → 原生分享，一趟改完 | 两步走：① Koishi、AstrBot 薄插件先发新版，同时认新旧名字；② 等用户都升上去，BN 再改发新名字，出口里的新旧映射整个删掉。两步都要在 1.0.0 之前做完；插件只发一次版 |
| devtools 换 devframe（09-27 从「1.0 之后」提前） | 先做小试验：查清许可证与维护者，重新验证 devtools 不进生产产物（守卫 14 与构建后自检照旧）；试验过了再换 |
| 新手引导换 driver.js（09-27 从「1.0 之后」提前） | 先做小试验：验证引导锁（聚光灯外不能操作，⛔ 不许放开）、跨页面的步骤与晚挂上的锚点、能不能跟随界面皮肤；试验过了再换 |

## 零碎施工项

| 项 | 归期 |
| --- | --- |
| 拓展契约 v3：min 抬到 3，删 v1、v2 的退路（`legacy-v1.ts` 连同过时注释）；`pickPerId` 改成「在当前 BN 装得了的版本里取最高」；索引规则放宽成「每个契约版本各留最新一条」；桥迁 v3，1.0 alpha 期间 v3 的桥只进预发布档 | 3b |
| 桥迁 v3 时必须抬 `extensions/bridge/extension.json` 的 `version`（现在 `0.0.1`，同号发出去市场永远不提示更新）；具体号发 alpha 时定 | 3b 抬号，6 定号 |
| 渲染器运行时从 `s1.hdslb.com` 拉舰长图标（`packages/image/src/image-renderer.ts` 的 `GUARD_LEVEL_IMG`），改成本地资产：B 站在 `bilibili/` 声明 `guard` 体系时用 `ctx.storeImage` 把三档图标存成 `tier.icon`，出图器只内联引用。守卫 11 的 `hdslb` 会在这里变红 | 3b |
| 补关注「-101 整批跳过、不降级」（已定未做，见 subscription-sources「B 站怎么实现」），随关注同步搬进 `bilibili/` | 3b |
| 直播监听的唯一判定（internal）；首页改用它。已知 bug「面板上『不会被监听』的提示和实际不符」就落在这条上，别拖到最后 | 3b；首页在 4 |
| 密钥打码：schema 标 `secret: true`、服务端按 `MaskedSecret` 下发；面板那一半（统一密钥输入框） | 3a；面板在 4 |
| 老 bug：会员文案自定义开着、图片是空串时 `??` 不兜底官方图，推出 href 为空的图。`templates.membership` 重做时顺手修（`default` 的回退正好在这条路上） | 2 |
| 测试助手重复：scripts 6 处各算 repoRoot、internal 三份 BASE AI 夹具、面板 UpDialog 三份 renderDialog 与造目标、`extSub` 与 `makeExtSub` 重复、backup 两份 pickFile | 各区重写那期合并，没重写到的归 5 |
| knip 报的 3 个老的未使用文件（`devtools/stub.ts`、两个 shape-pin；knip 不在 CI） | 5 |
| `constants-imports.test.ts` 按行判，多行 `export {…} from "zod"` 会漏；`UpDialog.test.tsx` 没有 JSX，应是 `.ts`；network-guard 夹具路径写了两处 | 5（守卫补齐） |
| 全仓包版本统一 `0.0.0-dev`：剩 push、subscription、internal、image、ai、storage、extension 7 个包（api / blive / dynamic / live 在 3a 随包删掉）。⛔ 不做：extension 包版本对齐契约档位 + 守卫（兼容看清单 apiVersion 与 EXTENSION_API_RANGE，不看包版本） | 5 |
| 进程托管文档：孤儿自检、stdin 关停、数据目录与端口、载荷选版；桌面版和以后的插件照同一份 | 5 |
| `docs/agents/self-update.md`：数据代、开机顺序、回退后再升级，以及 0.x → 1.0 这一次旧文件保持原样 | 5 |
| 文档同步：CLAUDE.md 与 `docs/agents/` 的 push、architecture、commands、events、devtools、self-update、extension-marketplace；补上 `subscriptions.md`（整篇讲 B 站 / 拓展两支、两个文件、两种键，1.0 后全错）、`build-release.md`（没有 dev-next 与 alpha 的打法）与 CLAUDE.md 的「分支」一节 | 5 |
