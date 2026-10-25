/**
 * 卡片皮肤契约 —— 卡种、预览场景、网格、字段、挂点、旋钮与内置块目录。
 *
 * 零依赖:只许 `import type`,值级 import 只能指向零依赖名单里的同伴。
 * 面板与 contract 经 `@bilibili-notify/internal/card-skin` 取值。
 */

// ---------------------------------------------------------------------------
// 自带字体的体积口径
// ---------------------------------------------------------------------------

/**
 * 单款字体的硬上限。完整中文字库的 ttf/otf 单字重就有 15-25MB,卡太死会把正常字体
 * 挡在门外,所以留到 20MB。
 *
 * 两端共享:服务端据它拒收(`apps/server/src/runtime/font-assets.ts`),前端据它写
 * 说明文案。
 */
export const MAX_FONT_ASSET_BYTES = 20 * 1024 * 1024;

/**
 * 超过它就在上传后提醒换 woff2。
 *
 * 上限那个数是按「文件本身多大」定的,**没算出图时的开销**:字体会被 base64 内联进
 * 渲染 HTML(再涨三分之一),而 Docker 镜像里 V8 的 old-space 上限只有 512MB
 * (见 `apps/Dockerfile`)。传一款 20MB 的 ttf 完全合法,出图时却可能把服务撑爆。
 *
 * 做成**提醒而不是拒收**:降上限会把已经传上去的字体挡在门外,那是破坏性的;而同一套
 * 字转成 woff2 通常只占 ttf 的三分之一,说清楚就够主人自己决定了。
 */
export const FONT_ASSET_WARN_BYTES = 8 * 1024 * 1024;

// ---- 卡片皮肤(ADR-0014)的零依赖词表 ----------------------------------------

/**
 * 七种卡。前四种有块可排;后三种(AI 周报榜单 / 单人锐评 / 弹幕词云)各自整张是**一个固定
 * 内置块**,皮肤只管外框(ADR-0014 决策 3)。
 */
export const CARD_KINDS = [
	"live",
	"post",
	"superchat",
	"membership",
	"roastBoard",
	"roastSolo",
	"wordcloud",
] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/**
 * 七种卡的中文名。卡片工坊的提示词与聊天里的工具小条共用这一份 —— 各写一份的话,
 * 加第八种卡时总有一边漏掉,而漏掉的那边是静默的。
 */
export const CARD_KIND_NAMES: Readonly<Record<CardKind, string>> = {
	live: "直播卡",
	post: "动态卡",
	superchat: "醒目留言卡",
	membership: "上舰卡",
	roastBoard: "锐评榜单卡",
	roastSolo: "单人锐评卡",
	wordcloud: "弹幕词云卡",
};

/**
 * 七种卡的中文**短名**:皮肤编辑器顶栏的 tab、回落告警里「哪种卡」这一处。与 {@link CARD_KIND_NAMES}(带「卡」字的全名)
 * 是同一张表的两种写法,**卡种中文名只许住在这里**(`__tests__/card-kind-names.test.ts` 扫源码钉着:别处再写一份就红)。
 */
export const CARD_KIND_SHORT_NAMES: Readonly<Record<CardKind, string>> = {
	live: "直播",
	post: "动态",
	superchat: "SC",
	membership: "上舰",
	roastBoard: "锐评榜单",
	roastSolo: "单人锐评",
	wordcloud: "词云",
};

/**
 * 卡片页类型导航上的名字 —— 只有按事件推的四种卡在那里出现(锐评与词云不走那一页)。名字说的是「什么事件触发它」,
 * 所以与短名不同(「直播开播」「SC 提醒」);同样只许住在这里。
 */
export const CARD_KIND_EVENT_NAMES: Readonly<
	Record<"live" | "post" | "superchat" | "membership", string>
> = {
	live: "直播开播",
	post: "动态发布",
	superchat: "SC 提醒",
	membership: "上舰提醒",
};

// ---- 预览场景 ---------------------------------------------------------------

/**
 * 编辑器实时预览里,一种卡可选的「场景」—— 同一张卡在不同状态下长得不一样(直播卡的
 * 直播中 / 下播、动态卡的纯文字 / 视频投稿 / 图文 / 转发),皮肤得挨个看过才知道有没有
 * 写塌。
 */
export interface PreviewScene {
	/** 稳定的机器名,进 URL / 请求体。小写 kebab。 */
	id: string;
	/** 面板上显示的中文短名,如「直播中」。 */
	label: string;
}

/**
 * 每种卡可选的场景,**第一项是默认**(没带 scene、或带了不认识的名字都落回它);面板照
 * 数组顺序显示。
 *
 * 住在 internal 而不是 `packages/image`,是依赖方向定的:面板(`apps/web`)要拿这张表画
 * 那排场景按钮,它经 `apps/contract` 借类型,而 contract 只准从 internal 借、`packages/*`
 * 又不许反向依赖 contract —— 只有 internal 这一份是出图端与面板都够得着的。所以它和
 * `CARD_SKIN_FIELDS` 是同一类东西:**契约常量**。场景对应的示例 props 是另一回事,那是
 * 出图端的活,住在 `packages/image` 的 `preview/sample-cards.ts`,面板一个字都不碰。
 */
export const CARD_PREVIEW_SCENES: Readonly<Record<CardKind, readonly PreviewScene[]>> = {
	// 直播卡两态各画各的(角标、时间行、粉丝行都不同);默认落在「直播中」—— 那是最常被
	// 看到的一张。「开播」不单列:它与直播中 `liveStatus` 都是 1,只差一句文案,出图端分不开,
	// 留着就只能是别名(ADR-0014 决策 10 的 2026-09-19 🔗)。
	live: [
		{ id: "streaming", label: "直播中" },
		{ id: "ended", label: "下播" },
	],
	// 四场按主媒体分,每一场就是出图端分得出来的一种卡:纯文字是底档(正文 + 话题 + 附加
	// 内容都在这儿看);「视频投稿」是真机上 UP 发视频推过来的那张 —— 只有头部、视频五块和
	// 互动数,没有正文、话题、附加内容(群里贴视频链接出的卡也是这个形状);「图文」是带图的
	// 那一种,图廊只有它看得到;转发单给一场:它里头是**另一整张卡**(转发框 + 跟着同一份
	// 皮肤摆的块),不单列的话皮肤作者在面板上一眼都看不到这一层。
	// 从前的「全字段」(视频 + 正文 + 话题)砍了 —— 它在出图端与「视频投稿」是同一种卡。
	post: [
		{ id: "text", label: "纯文字" },
		{ id: "video", label: "视频投稿" },
		{ id: "pics", label: "图文" },
		{ id: "forward", label: "转发" },
	],
	superchat: [{ id: "default", label: "醒目留言" }],
	membership: [{ id: "default", label: "上舰" }],
	roastBoard: [{ id: "default", label: "锐评榜单" }],
	roastSolo: [{ id: "default", label: "单人锐评" }],
	wordcloud: [{ id: "default", label: "词云" }],
};

/**
 * 请求里那个场景名 → 真正要用的场景。**认不出就回落到第一个**,不报错:场景名从 URL /
 * 请求体来,面板换过一版、链接被人存过书签都会送来旧名字,为这个给张错误页不值。
 *
 * 收成一处是因为有**两个**调用方(出图端挑示例数据、预览路由回报「实际用了哪个」),
 * 各写一遍 `find ?? 第一个` 的话,哪天回落规则改了就只改得动其中一边。
 */
export function resolvePreviewScene(kind: CardKind, scene?: string): PreviewScene {
	const scenes = CARD_PREVIEW_SCENES[kind];
	// biome-ignore lint/style/noNonNullAssertion: 表里每种卡都至少一个场景,有测试钉着
	return scenes.find((s) => s.id === scene) ?? scenes[0]!;
}

/**
 * 块在网格里的位置(与 `CardSkinBlockSchema` 的 `grid` 同形)。声明在这里而不是 schema 里,
 * 是为了让**零依赖**的 {@link rowMapOf} 也能用上 —— 画布经 `@bilibili-notify/internal/card-skin` 子路径运行时
 * 消费它,不能把 zod 拖进前端 bundle(与 {@link AIProviderProfileShape} 同一条理由)。
 */
export interface CardSkinGrid {
	row: number;
	column: number;
	span: number;
	rowSpan?: number;
	z?: number;
}

/**
 * **压行**:把一组块**占到**的行按从小到大重编成 1..n,回一张「真行号 → 压后行号」的表。
 * 占到 ≠ 起在:跨行的块把中间那几行也占着,漏掉它们就会把下一块压进它身上;一个块占的
 * 行因此恒是连着的一段,`rowSpan` 不用跟着改。整行没块的行不在表里 —— 那就是被压掉的行。
 *
 * 出图端与画布**共用这一处**(ADR-0014 决策 10 的 2026-09-19 🔗「画布与出图一样紧」):
 * 各写一遍的话,编辑器里看着紧贴的两块,真画出来中间多一条缝,或者反过来。
 */
export function rowMapOf(
	grids: Iterable<Pick<CardSkinGrid, "row" | "rowSpan">>,
): Map<number, number> {
	const occupied = new Set<number>();
	for (const { row, rowSpan } of grids) {
		for (let r = row; r < row + (rowSpan ?? 1); r++) occupied.add(r);
	}
	const map = new Map<number, number>();
	for (const r of [...occupied].sort((a, b) => a - b)) map.set(r, map.size + 1);
	return map;
}

/**
 * **皮肤自定义旋钮**(ADR-0014 决策 16 的 🔗,2026-09-14:主人推翻自己「被否:皮肤自定义
 * 旋钮」那一条)。皮肤声明几枚旋钮,面板照声明生成控件,用户拧出来的值注成
 * `--bn-knob-<key>`,皮肤 CSS 里 `var(--bn-knob-<key>, <自己的默认>)` 引用。
 *
 * 固定变量表({@link CARD_SKIN_VARIABLES})管的是**用户的资产**(背景图)与**数据**
 * (档位色):皮肤换了它们还在。旋钮管的是**这套皮肤自己的调色板**:皮肤换了就换一套。
 *
 * 🔴 **`default` 不注入**。它只是面板控件的起始位置;用户没动过就什么都不注,皮肤 CSS 里
 * 那个 `var(…, 兜底)` 的兜底生效(「存覆盖不存值」,决策 16 的第二个 🔗)。这条不是省事:
 * 默认皮肤的玻璃白纱各卡基线不同(直播 .82 / SC .75 / 锐评 .86),注了就只能注一个数、
 * 三档立刻塌成一档;不注,各卡 CSS 写各自的兜底,用户一拧才统一覆盖。
 */
export const CARD_SKIN_KNOB_LIMITS = {
	/** 一套皮肤最多几枚旋钮(面板一屏能拧完的量)。 */
	maxKnobs: 16,
	/** 下拉最多几个候选。 */
	maxOptions: 8,
	/** 旋钮 / 候选的人话名长度。 */
	label: { max: 24 },
	/** key 长度(变量名要人能读)。 */
	key: { max: 32 },
	/** 下拉候选 / 开关两端那种字面量的长度。 */
	value: { max: 80 },
	/** 一枚图片旋钮最多选几张(多张按推送轮换)。与皮肤包内资产同量级。 */
	maxImages: 12,
} as const;

/**
 * key:小写字母起头的 kebab。它直接拼进变量名,所以大写(CSS 自定义属性大小写敏感,
 * 面板与 CSS 各写一种就永远对不上)、下划线、非 ASCII 都不收。
 */
export const CARD_SKIN_KNOB_KEY_RE = /^[a-z][a-z0-9-]*$/;

/** 数值旋钮的单位。固定几种 —— 单位直接拼在数字后面进 CSS,不能是自由文本。 */
export const CARD_SKIN_KNOB_UNITS = ["px", "%", "em", "rem", "deg", "s", "ms"] as const;
export type CardSkinKnobUnit = (typeof CARD_SKIN_KNOB_UNITS)[number];

// ---- 上限 -------------------------------------------------------------------

/** 取值域的唯一事实源:server 的清洗 / 装包与 web 的编辑器都从这里读。 */
export const CARD_SKIN_LIMITS = {
	/** 网格列数,固定(CSS grid 惯例,2 / 3 / 4 等分都整除)。 */
	columns: 12,
	/** 卡宽 px。下限要装得下上舰卡的徽章 + 两行字,上限是截图与群里看图的常识。 */
	width: { min: 240, max: 1200 },
	/** 行 / 列间距 px。 */
	gap: { min: 0, max: 64 },
	/**
	 * **出血** px —— 卡片四周留给辉光的那圈余量(2026-09-14 主人拍板)。
	 *
	 * 存在的理由:出图截的是 `html` 的 boundingBox,而 `box-shadow` / `filter` 的辉光
	 * **不参与布局、不撑大任何盒子**,所以画在卡外的那一圈在成品里一个像素都没有。
	 * 皮肤要辉光就得自己声明留多宽,以及那圈底什么色(JPEG 没有 alpha,不给色就是白边)。
	 *
	 * 上限跟 `gap` 同一个数:64 已经是 600 宽的卡外扩到 728,再宽就不像一张卡了。
	 */
	bleed: { min: 0, max: 64 },
	/** 一张卡最多几个块。 */
	maxBlocks: 40,
	/** 网格最多几行(块的 row 上限)。 */
	maxRows: 60,
	/**
	 * **一行多高** px。画布按它画格子,出图按它给「单张图」那类块算真高度
	 * ({@link CardSkinBuiltinBlock.heightFromRows},2026-09-18 主人拍板)。
	 *
	 * 两边必须是同一个数:画布上量着 3 行摆好的封面,出图得也是那么高 —— 各写一份的话,
	 * 编辑器里摆的和真画出来的迟早是两回事(这一摊已经栽过)。
	 *
	 * 56 是画布先定的:再矮,块名与那行 `id · 列区间` 的小字就挤不下了。它同时也就成了
	 * 作者调图高的**步长**,粗是粗了点,但网格本来就是格子。
	 */
	rowHeight: 56,
	/**
	 * **层次** —— 两个块占同一片格子时谁压在上面(2026-09-15 主人拍板「重叠是特性」)。
	 *
	 * 网格允许两个块的列区间相交,那是 CSS Grid 的正常行为,也真有人要
	 * (角标压在封面上)。但不写层次的话,谁压谁只看块在数组里的先后 —— 想调就得去
	 * 改块的顺序,而那同时会改掉别的东西。
	 *
	 * 上限 9:十层足够表达一张卡里的任何前后关系,而数字一大,面板上那个框就开始
	 * 像个能填 9999 的东西了。**不给负数** —— 0 是地面,要沉底就把别的抬高,
	 * 留负数只会让「默认 0」变成一个有上有下的中间层,平白多一种想不清楚的状态。
	 */
	layer: { min: 0, max: 9 },
	/**
	 * 每块 CSS 的字节上限(含根块)。**按 UTF-8 字节算**,量的人是
	 * {@link cardSkinBytes} —— 三层(清洗器 / schema / 面板计数器)必须同一把尺。
	 */
	maxCssBytes: 16 * 1024,
	/** 每个自定义块 HTML 的字节上限(同上,UTF-8 字节)。 */
	maxHtmlBytes: 8 * 1024,
	/** 包名 / 作者 / 描述的长度。 */
	name: { min: 1, max: 40 },
	author: { max: 40 },
	description: { max: 200 },
	/** 包内资产数量与单个体积(与 dashboard 皮肤同量级)。 */
	maxAssets: 12,
	maxAssetBytes: 5 * 1024 * 1024,
	/** 根 / 块各自那张「资产变量表」最多几项(ADR-0014 决策 13 的 🔗:`--bn-asset-<名>`)。 */
	maxAssetVars: 8,
	/** 皮肤级 `fonts` 最多几款。 */
	maxFonts: 4,
	/**
	 * 出图后的卡片最大高度 px(ADR-0014 决策 19「卡片有最大高度,超了算失败」)。
	 *
	 * 4000 是从**两头**夹出来的:今天最高的一张真卡是九图动态(600 宽 × 约 1800 高),
	 * 留一倍余量让长图文动态不误伤;另一头,截图是 `page.screenshot` 一次性出一张 JPEG,
	 * 600 × 4000 已是 240 万像素、几兆内存,而镜像里 V8 的 old-space 只有 512MB ——
	 * 再往上一个数量级(一条 `height:100vh` 写错的皮肤 CSS 就能做到)会把浏览器和
	 * 本进程一起拖垮,而症状只是「推送莫名其妙停了」。
	 *
	 * 超限只回落默认皮肤重画一次,**不拒发**:内容本来就长的时候默认皮肤也会超,那是
	 * 内容的问题不是皮肤的,照发。
	 */
	maxHeight: 4000,
} as const;

/**
 * 皮肤里那几道体积闸量的**同一把尺**:UTF-8 字节。
 *
 * 三层都得用它 —— server 的清洗器、`CardSkinBlockSchema` 的长度闸、面板上那个
 * 「3000 / 8192」计数器。用 `s.length` 量的是 UTF-16 单元数,一个汉字才记 1:
 * 中文密集的自定义块会在面板上显示得好好的、也过得了 schema,存的时候被清洗器
 * 退回来。挑字节当权威是因为存盘与 zip 预算算的本来就是字节。
 *
 * `TextEncoder` 浏览器与 Node 都有;server 那两处用的 `Buffer.byteLength(s, "utf8")`
 * 结果相同,不必改回来。
 */
const UTF8 = new TextEncoder();

export function cardSkinBytes(s: string): number {
	return UTF8.encode(s).length;
}

// ---- 卡片皮肤的数据契约 ----------------------------------------------------------------

export type CardSkinFieldType = "text" | "number" | "bool" | "image";

/** 一个对外字段:路径、类型、人话名。`image` 类型才准出现在 `<img src="{…}">` 里。 */
export interface CardSkinField {
	path: string;
	type: CardSkinFieldType;
	label: string;
}

const f = (path: string, type: CardSkinFieldType, label: string): CardSkinField => ({
	path,
	type,
	label,
});

/** 各卡的创作者那两格。同名同义:每种卡上 `creator.*` 都是「这张卡讲的创作者」,没有平台的叫法(UP 主 / 主播 / master)。 */
const CREATOR_FIELDS = [
	f("creator.name", "text", "创作者名"),
	f("creator.avatar", "image", "创作者头像"),
];

/**
 * 每种卡对外承诺的字段(ADR-0014 决策 14)。**只增不删不改名。**(㉓ 把醒目留言与会员两张卡的字段改到最终名字、㉔ 把其余
 * 卡的字段改到最终名字是例外:皮肤格式版本只在 alpha 前抬一次,那时没有 1.0 的皮肤可言,老包拒收 —— ADR-0021 决策 26 下
 * 2026-10-05 的 🔗、ADR-0023 决策 3 下 2026-10-06 的 🔗。)
 * 已格式化的文本(「1.2 万」「已开播 1 小时」)直接给,占位符不带过滤器。
 * `is*` / `has*` 一律 bool,是 `showIf` 的目标。
 */
export const CARD_SKIN_FIELDS: Record<CardKind, readonly CardSkinField[]> = {
	live: [
		...CREATOR_FIELDS,
		f("live.title", "text", "直播标题"),
		f("live.category", "text", "分类"),
		f("live.time", "text", "开播时长 / 下播时间那句"),
		f("live.description", "text", "房间简介(纯文本)"),
		// 封面永远画得出来:没有真封面时 `live.cover` 给 BN 自带的占位图(不是空串 —— 没写
		// `showIf` 的皮肤也不会裂图),`live.hasCover` 如实为假;想整格收起就 `showIf` 它。
		f("live.cover", "image", "封面(生效的那张;没有真封面时是占位图)"),
		f("live.hasCover", "bool", "有没有真封面(占位图不算)"),
		f("live.isStreaming", "bool", "正在直播"),
		f("live.isEnded", "bool", "已下播"),
		// 每格只装名字说的那一样;不该有值的状态下是空串(字段表规定永不 undefined)。
		f("stats.currentViewers", "text", "在看人数(开播 / 直播中)"),
		f("stats.likes", "text", "点赞(下播)"),
		f("stats.followers", "text", "粉丝数(开播 / 直播中)"),
		f("stats.totalViewers", "text", "累计观看(下播)"),
		f("stats.followersDelta", "text", "粉丝变化(下播才有)"),
		f("stats.hasFollowersDelta", "bool", "有没有粉丝变化"),
	],
	post: [
		...CREATOR_FIELDS,
		f("creator.isPremium", "bool", "是付费会员"),
		f("post.label", "text", "「投稿了视频」这类动作标签(内外层卡都有)"),
		f("post.time", "text", "发布时间(只有时间,不带标签)"),
		f("post.topic", "text", "话题"),
		f("post.hasTopic", "bool", "有没有话题"),
		f("post.hasRepost", "bool", "是转发"),
		f("post.hasAttachment", "bool", "有没有附加内容(预约 / 商品…)"),
		f("post.hasVideo", "bool", "带视频卡"),
		f("post.hasImages", "bool", "带图"),
		f("video.title", "text", "视频标题"),
		f("video.description", "text", "视频简介"),
		f("video.cover", "image", "视频封面"),
		f("video.duration", "text", "视频时长"),
		f("video.views", "text", "播放量"),
		f("video.danmaku", "text", "弹幕数"),
		f("images.count", "number", "图片张数"),
		f("images.first", "image", "第一张图"),
		f("stats.shares", "text", "转发数"),
		f("stats.comments", "text", "评论数"),
		f("stats.likes", "text", "点赞数"),
	],
	// 醒目留言卡与会员卡两组字段随 ㉓ 改到最终名字(ADR-0021 决策 26 下 2026-10-05 的 🔗):观众是 `viewer.*`,
	// 醒目留言的东西在 `superchat.*`,会员的在 `membership.*`;主播那两格 `master.*` 随 ㉔b 改成 `creator.*`。
	superchat: [
		f("viewer.name", "text", "观众名"),
		f("viewer.avatar", "image", "观众头像(没有就是空串)"),
		...CREATOR_FIELDS,
		f("superchat.amount", "text", "金额(带货币符号,排好的字)"),
		f("superchat.amountValue", "number", "金额数字"),
		f("superchat.duration", "text", "留言时长(来源没给就是空串)"),
		f("superchat.rank", "number", "价位档(1~6,1 最低)"),
		f("superchat.text", "text", "留言"),
	],
	membership: [
		f("viewer.name", "text", "观众名"),
		f("viewer.avatar", "image", "观众头像(没有就是空串)"),
		...CREATOR_FIELDS,
		f("membership.rank", "number", "档位(从 1 起、1 最低;没有 rank 的档是 0)"),
		f("membership.tierName", "text", "档名"),
		f("membership.icon", "image", "徽章图"),
		f("membership.announcement", "text", "宣告语(档位没声明就是空串)"),
	],
	// 榜单周报不属于任何单个创作者,没有创作者那两格(从前留着一个恒为空串的 `master.name`,㉔b 删了)。
	roastBoard: [f("report.days", "number", "统计天数")],
	roastSolo: [...CREATOR_FIELDS, f("report.days", "number", "统计天数")],
	wordcloud: [...CREATOR_FIELDS],
};

/**
 * 每块 CSS 里指「块自己」的挂点。皮肤写 `[data-bn="self"]`,渲染器把它翻成该块的真实
 * 选择器 —— 与 dashboard 皮肤同一套「按 hook 存盘、注入时翻译」的哲学。
 */
export const CARD_SKIN_SELF_HOOK = "self";

/**
 * 根块(卡片外框)的两层挂点。外层是渐变 / 背景图那层(带 15px 内边距),内层是玻璃层
 * (圆角 / 阴影 / 白纱 / 模糊)。块都画在玻璃层里。
 */
export const CARD_SKIN_FRAME_HOOKS = {
	frame: "外框(渐变 / 背景图那一层)",
	glass: "玻璃层(圆角、阴影、白纱、模糊)",
} as const;
export type CardSkinFrameHook = keyof typeof CARD_SKIN_FRAME_HOOKS;

/**
 * **档位属性**(㉔d,ADR-0028 决策 4 的 2026-10-06 🔗:按档换色的挂点是属性,不是 `data-bn` 挂点)。出图器在带档位的
 * 两种卡({@link CARD_SKIN_RANKED_KINDS})的**外框**(`frame` 那一层)和**每个块的 wrapper**(带 `bn-blk-<id>` 的那层 div)
 * 上写 `data-rank="<档位>"`:醒目留言是视图上夹进 1–6 的有效档位,会员是视图的 `rank`、没有 rank(0)的档不写;
 * 别的卡一律不写。皮肤 CSS 用属性选择器按档写规则 —— 清洗器对 `data-bn` 以外的属性一概不查,所以零改动。
 * **对外 API**,只增不改。
 */
export const CARD_SKIN_RANK_ATTR = "data-rank";

/** 带档位属性的卡种:醒目留言卡与会员卡(其余卡没有「档」这回事)。 */
export const CARD_SKIN_RANKED_KINDS = [
	"superchat",
	"membership",
] as const satisfies readonly CardKind[];

/**
 * 给皮肤作者与 AI 做皮肤的说明:按档换色怎么写、限制是什么。编辑器的 CSS 一节与 AI 的规则提示词读同一段,不各抄一份。
 */
export const CARD_SKIN_RANK_GUIDE =
	`醒目留言卡与会员卡的外框和每个块的 wrapper 上有属性 ${CARD_SKIN_RANK_ATTR}="<档位>"` +
	`(醒目留言是 1–6、1 最低;会员是档位的 rank、从 1 起、1 最低;没有 rank 的会员档不带这个属性)。` +
	`按档换色用属性选择器:块的 CSS 写 [data-bn="${CARD_SKIN_SELF_HOOK}"][${CARD_SKIN_RANK_ATTR}="3"]{…},` +
	`外框的 CSS 写 [data-bn="frame"][${CARD_SKIN_RANK_ATTR}="3"]{…}。` +
	`限制:档色变量(--bn-card-tier-color 等)是出图器直接写在元素上的,皮肤 CSS 盖不掉它,` +
	`所以按档换色要对想换的部位直接写颜色属性(color / background-color / border-color…),不要去改那个变量。`;

/** 主人自己传上来的资产在旋钮值里的前缀。**对外 API**,只增不改。 */
export const CARD_SKIN_UPLOAD_PREFIX = "upload:";

/**
 * 字体旋钮的值 → 宿主要做什么。
 *
 * - `upload:<资产 id>` —— 主人传的字体文件,宿主读盘拼 `@font-face`(与 `cardStyle.fontAsset`
 *   从前同一条路);
 * - 别的非空字符串 —— 一个家族名(系统字体、手填的、或者皮肤自带的那几款);
 * - 空串 / 别的类型 —— 没什么要注的(跟着兜底链走)。
 */
export function parseCardSkinFontKnobValue(
	value: unknown,
): { upload: string } | { family: string } | null {
	if (typeof value !== "string" || value === "") return null;
	if (value.startsWith(CARD_SKIN_UPLOAD_PREFIX)) {
		const id = value.slice(CARD_SKIN_UPLOAD_PREFIX.length);
		return id === "" ? null : { upload: id };
	}
	return { family: value };
}

/**
 * 图片旋钮的值 → 一串资产 id(多张按推送轮换)。空列表与「没拧过」同义,回 null。
 *
 * 混进来的空串 / 非字符串**剔掉**而不是整条作废:存量里被手改过的值不该让一整张卡的
 * 背景凭空消失。
 */
export function parseCardSkinImageKnobValue(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const ids = value.filter((v): v is string => typeof v === "string" && v !== "");
	return ids.length > 0 ? ids : null;
}

/**
 * 一套皮肤**生效**的旋钮覆盖:per-UP 那层叠在全局那层上,**逐枚**合并(ADR-0014 决策 17 的
 * 🔗,2026-09-24)—— per-UP 拧过的 → 全局拧过的 → 两层都没有的键不出现(皮肤 CSS 的兜底管事)。
 *
 * 两层都按皮肤 id 分(`globals.defaults.cardSkinKnobs` 与 `overrides.cardSkinKnobs` 同形),只取
 * `skinId` 那一格:这位 UP 存着别的皮肤那份覆盖时,它对这套皮肤不生效。
 *
 * 判「拧过没有」只看**键在不在**(存覆盖不存值),不看值合不合法 —— per-UP 那层存着一个残值时
 * 它照样压过全局,注入前那道闸(`cardSkinKnobCss`)把它挡下,于是画皮肤兜底。
 *
 * 出图、预览、面板三处都经它,住零依赖的这里是因为面板也要拿它算「跟随全局」时的起始位置。
 */
export function effectiveCardSkinKnobs<V>(
	global: Readonly<Record<string, Readonly<Record<string, V>>>> | undefined,
	perUp: Readonly<Record<string, Readonly<Record<string, V>>>> | undefined,
	skinId: string,
): Readonly<Record<string, V>> | undefined {
	const g = global?.[skinId];
	const u = perUp?.[skinId];
	if (u === undefined) return g;
	return { ...g, ...u };
}

/** 一个内置块的目录条目:人话名 + 它内部可分别挂 CSS 的部件。 */
export interface CardSkinBuiltinBlock {
	label: string;
	/** 是复合块(头像 + 名字 + 时间捆一起)还是原子块(只画一样)。编辑器分组用。 */
	atom?: true;
	/**
	 * 内部挂点 → 人话名。皮肤写 `[data-bn="avatar"]`。
	 *
	 * `self` 是渲染器包在块外面那层 wrapper(网格里的格子),**不是块自己的根元素**。所以
	 * 2026-09-19 起(ADR-0014 决策 7 的 🔗)原子块的根也挂一个:它长什么样(字号、字色、圆角、
	 * 胶囊底色)全写在默认皮肤这个挂点的规则里,渲染器只留结构。根挂点的名字只有几个,按
	 * 「它是什么」取:图 `image`、文字 `text`、胶囊 / 角标 `pill`、留言气泡 `bubble`、分割线
	 * `line`;根之外的部件照旧各有各的名(正文文字里的 `body`、图廊里的 `pic`、互动数里的
	 * `icon`)。`atom` 只管编辑器分组,不代表「没有挂点」。
	 */
	hooks: Record<string, string>;
	/**
	 * 这块画的是**一张有确定尺寸的图**,它的高度由 `grid.rowSpan` 说了算
	 * (`rowSpan × ` {@link CARD_SKIN_LIMITS.rowHeight}),不由内容撑;图按
	 * `object-fit:cover` 填满那块地方(按比例裁,不压扁)。2026-09-18 主人拍板。
	 *
	 * **只标单张图。**文字块的高度取决于真实数据(标题一行还是三行、简介几行),写死就是
	 * 裁字或压到下一块身上 —— 那正是 ADR-0014 决策 6 否掉「绝对坐标排版」的理由;图廊
	 * 同理,它多高取决于有几张图。没标的块 `rowSpan` 照旧只是给画布看的一句声明。
	 *
	 * 画布照它决定上下两条边画不画把手:拉得动的,拉完出图就真的跟着变。
	 */
	heightFromRows?: true;
	/**
	 * 这块**只属于这几场**(`CARD_PREVIEW_SCENES[kind]` 里的 id;ADR-0014 决策 10 的
	 * 2026-09-19 🔗)。不写 = 共有块,每一场都有它。
	 *
	 * 只给编辑器用:画布切到哪一场就只摆这一场会有的块,加块目录上给独有块挂个小标。
	 * **出图端不读它** —— 图廊在视频那场本来就没数据、整块不画,目录只是把这件事提前
	 * 告诉画布。所以皮肤格式里没有任何场景名单:共有块改了处处改,没有「专属本场」。
	 */
	scenes?: readonly string[];
}

/**
 * 分割线块的块名。原来住在旧版式那份 schema 里(它退役了,见 ADR-0014 决策 17 的
 * 2026-09-18 🔗),但渲染器要靠它认出分割线 —— 「开头的收起、悬空的收起、末尾的弹掉」
 * 那套规矩就是按它判的。**单点定义**:块目录、皮肤渲染器、四份块库认的是同一个字符串。
 */
export const DIVIDER_TYPE = "divider";

/** 四种可编辑卡共用的分割线。 */
const DIVIDER_BLOCK: CardSkinBuiltinBlock = { label: "分割线", atom: true, hooks: { line: "线" } };

/**
 * 内置块目录:每种卡有哪些块、每块内部有哪些挂点。**块名与挂点名是对外 API。**
 *
 * **只有原子块与天生拆不动的块**(ADR-0014 决策 8 的 2026-09-18 🔗):复合块整批退役了 ——
 * 用户多是从默认皮肤复制一份再改,目录里留着「一块顶半张卡」的东西,能挪的就只有整行。
 *
 * `atom` 分的是**「这块画一样东西,还是捆了好几样」**,不是「能不能再拆」:转发框里确实
 * 套着一整张内层卡、图廊里确实有好几张图,但搬动时它们各是一件,所以是原子块。剩下的
 * 非原子块是一份**闭集**,由 `card-blocks.test.ts` 钉着:附加内容(预约 / 商品 / 通用 /
 * 关联视频四种形态结构各异、字段不在契约里,主人拍板不拆)与三种不可编辑卡的整卡块。
 */
export const CARD_SKIN_BUILTIN_BLOCKS: Record<CardKind, Record<string, CardSkinBuiltinBlock>> = {
	live: {
		// 角标与封面**占同一片格子**、层次更高,不再嵌在封面里(决策 8 的 2026-09-18 🔗)。
		// ⚠️ `image` 挂点是拆封面之前就有的**公开 API**,拆的时候连同 `<img>` 上那个
		// `data-bn` 一起掉了一次(`5fa842ca`)—— 挂点名只增不改不删,而且没有它,皮肤连
		// 「把封面压矮一点」都写不出来(`[data-bn="self"]` 是外面那层 div,在它上面写
		// height 图会直接溢出去)。
		cover: { label: "封面图", atom: true, heightFromRows: true, hooks: { image: "封面图片" } },
		status: { label: "直播状态", atom: true, hooks: { pill: "胶囊" } },
		title: { label: "直播标题", atom: true, hooks: { text: "文字" } },
		description: { label: "简介", atom: true, hooks: { text: "文字" } },
		[DIVIDER_TYPE]: DIVIDER_BLOCK,
		creatorAvatar: { label: "头像", atom: true, hooks: { image: "头像图片" } },
		creatorName: { label: "创作者名", atom: true, hooks: { text: "文字" } },
		time: { label: "开播时间", atom: true, hooks: { text: "文字" } },
		// 数据区(ADR-0014 决策 16 的 🔗):从前由三个显隐开关管,而开关管的是复合块
		// **内部的一行**、块级的 `showIf` 够不着 —— 所以拆成原子块,想少显示哪件就删哪块。
		// ㉔c 起随状态换含义的两块各拆成两块(`popularity` → `currentViewers` + `likes`,`fans` → `followers` +
		// `totalViewers`):每块只画一样东西,各自只在该出现的状态下有内容(`scenes` 只给画布用,出图端不读)。
		currentViewers: {
			label: "在看人数",
			atom: true,
			hooks: { text: "文字" },
			scenes: ["streaming"],
		},
		likes: { label: "点赞数", atom: true, hooks: { text: "文字" }, scenes: ["ended"] },
		category: { label: "分类", atom: true, hooks: { text: "文字" } },
		followers: { label: "粉丝数", atom: true, hooks: { text: "文字" }, scenes: ["streaming"] },
		totalViewers: { label: "累计观看", atom: true, hooks: { text: "文字" }, scenes: ["ended"] },
	},
	post: {
		attachment: {
			label: "附加内容",
			hooks: { card: "附加卡", cover: "附加卡封面", button: "按钮" },
		},
		[DIVIDER_TYPE]: DIVIDER_BLOCK,
		creatorAvatar: { label: "头像", atom: true, hooks: { image: "头像图片" } },
		creatorName: { label: "创作者名", atom: true, hooks: { text: "文字" } },
		time: { label: "发布时间", atom: true, hooks: { text: "文字" } },
		// 文字与媒体是呈现态里分开的几份(`PostNode.text` / `.video` / `.images`)。
		topic: { label: "话题", atom: true, hooks: { text: "文字" } },
		// 正文富文本整段留在渲染器(决策 7 的 2026-09-19 🔗),所以这块没有根挂点 ——
		// `body` 是富文本自己的根,样子也归它。
		text: { label: "正文文字", atom: true, hooks: { body: "正文" } },
		// 投稿视频那张卡拆成的五块。外面那圈灰底圆角容器不是块,是皮肤用 CSS 拼的 ——
		// 三段文字各带一段灰底、首尾分担圆角(决策 8 的 2026-09-18 🔗)。
		// 三组独有块各自只属于一场(`scenes`):画布切到别的场就不摆它们。
		videoCover: {
			label: "视频封面",
			atom: true,
			heightFromRows: true,
			hooks: { image: "封面图片" },
			scenes: ["video"],
		},
		videoDuration: { label: "视频时长", atom: true, hooks: { pill: "角标" }, scenes: ["video"] },
		videoTitle: { label: "视频标题", atom: true, hooks: { text: "文字" }, scenes: ["video"] },
		videoDescription: { label: "视频简介", atom: true, hooks: { text: "文字" }, scenes: ["video"] },
		videoStats: {
			label: "播放 · 弹幕数",
			atom: true,
			hooks: { text: "文字", stat: "一项数据" },
			scenes: ["video"],
		},
		// 图廊张数是动态的,拆不开,整块画。
		images: {
			label: "图廊",
			atom: true,
			hooks: { images: "图廊", image: "图廊里的一张图" },
			scenes: ["pics"],
		},
		// 根就是转发框,它的样子挂在 `bubble` 上;框里是一整张内层卡,那些部件归内层卡
		// 自己的块管,这里不声明。
		repost: { label: "转发框", atom: true, hooks: { bubble: "转发框" }, scenes: ["forward"] },
		shareCount: { label: "转发数", atom: true, hooks: { text: "文字", icon: "图标" } },
		commentCount: { label: "评论数", atom: true, hooks: { text: "文字", icon: "图标" } },
		likeCount: { label: "点赞数", atom: true, hooks: { text: "文字", icon: "图标" } },
	},
	superchat: {
		// 留言的根是一层撑满格子的壳(居中靠块的 `self` 说),气泡与文字各一个挂点。
		message: { label: "留言", atom: true, hooks: { bubble: "留言气泡", text: "留言文本" } },
		[DIVIDER_TYPE]: DIVIDER_BLOCK,
		// 头像的根是那个把图裁圆的框,`image` 挂在框上 —— 尺寸与圆都归它,里头的 img 填满即可。
		viewerAvatar: { label: "发送者头像", atom: true, hooks: { image: "头像图片" } },
		viewerName: { label: "发送者名", atom: true, hooks: { pill: "胶囊" } },
		amount: { label: "金额", atom: true, hooks: { text: "文字" } },
		duration: { label: "时长胶囊", atom: true, hooks: { pill: "胶囊" } },
		to: {
			label: "「SC to」那一行",
			atom: true,
			hooks: {
				text: "文字",
				label: "「SC to」三个字",
				creator: "主播那一组",
				creatorAvatar: "主播小头像",
				creatorName: "主播名",
			},
		},
	},
	membership: {
		icon: { label: "会员徽章", atom: true, hooks: { image: "徽章图" } },
		announcement: { label: "宣告语", atom: true, hooks: { text: "文字" } },
		[DIVIDER_TYPE]: DIVIDER_BLOCK,
		// 头像的根是那个把图裁圆的框,`image` 挂在框上 —— 尺寸与圆都归它。
		viewerAvatar: { label: "头像", atom: true, hooks: { image: "头像图片" } },
		viewerName: { label: "用户名胶囊", atom: true, hooks: { pill: "胶囊", text: "文字" } },
		creator: {
			label: "主播胶囊",
			atom: true,
			hooks: { pill: "胶囊", creatorAvatar: "主播小头像", creatorName: "主播名" },
		},
	},
	roastBoard: { body: { label: "周报榜单", hooks: {} } },
	roastSolo: { body: { label: "单人锐评", hooks: {} } },
	wordcloud: { body: { label: "弹幕词云", hooks: {} } },
};
