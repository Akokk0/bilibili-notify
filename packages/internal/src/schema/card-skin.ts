import { z } from "zod";

/**
 * 卡片皮肤包(ADR-0014)—— 推送卡片图的皮肤:一份 JSON 描述七种卡各自的**网格、块与
 * 每块的 CSS**,由 `packages/image` 按它装配出图。这里是它的**契约**:什么样的包能进门、
 * 有哪些内置块与挂点、模版能引用哪些字段、变量叫什么名。
 *
 * 三条纪律:
 * - **挂点名、字段路径、变量名都是对外 API,只增不改不删**(第三方皮肤会写死它们)。
 * - 这层只量长度不看内容:CSS 与自定义 HTML 的清洗归 server 的清洗器,渲染器只吃洗过的。
 * - 默认皮肤(`DEFAULT_CARD_SKIN`)必须能用这套格式**复刻今天的外观** —— 它是格式够不够
 *   用的验收门,也是升级后用户零感知的依据。
 */

// ---- 版本 -------------------------------------------------------------------

/** 皮肤包格式的版本。结构不兼容地演进时递增。 */
export const CARD_SKIN_SCHEMA_VERSION = 1;

/**
 * 数据契约(`CARD_SKIN_FIELDS`)的版本。字段**只增**,所以它只在「有字段被加进来」时递增,
 * 老皮肤永远能画 —— 皮肤包记下自己写时依据的版本,只是给编辑器提示「有新字段可用」。
 */
export const CARD_DATA_VERSION = 1;

// ---- 卡种 -------------------------------------------------------------------

/**
 * 七种卡。前四种有块可排;后三种(AI 周报榜单 / 单人锐评 / 弹幕词云)各自整张是**一个固定
 * 内置块**,皮肤只管外框(ADR-0014 决策 3)。
 */
export const CARD_SKIN_KINDS = [
	"live",
	"dynamic",
	"sc",
	"guard",
	"roastBoard",
	"roastSolo",
	"wordcloud",
] as const;
export type CardSkinKind = (typeof CARD_SKIN_KINDS)[number];
export const CardSkinKindSchema = z.enum(CARD_SKIN_KINDS);

// ---- 上限 -------------------------------------------------------------------

/** 取值域的唯一事实源:server 的清洗 / 装包与 web 的编辑器都从这里读。 */
export const CARD_SKIN_LIMITS = {
	/** 网格列数,固定(CSS grid 惯例,2 / 3 / 4 等分都整除)。 */
	columns: 12,
	/** 卡宽 px。下限要装得下上舰卡的徽章 + 两行字,上限是截图与群里看图的常识。 */
	width: { min: 240, max: 1200 },
	/** 行 / 列间距 px。 */
	gap: { min: 0, max: 64 },
	/** 一张卡最多几个块。 */
	maxBlocks: 40,
	/** 网格最多几行(块的 row 上限)。 */
	maxRows: 60,
	/** 每块 CSS 的字节上限(含根块)。 */
	maxCssBytes: 16 * 1024,
	/** 每个自定义块 HTML 的字节上限。 */
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

// ---- 挂点 -------------------------------------------------------------------

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

/** 一个内置块的目录条目:人话名 + 它内部可分别挂 CSS 的部件。 */
export interface CardSkinBuiltinBlock {
	label: string;
	/** 是复合块(头像 + 名字 + 时间捆一起)还是原子块(只画一样)。编辑器分组用。 */
	atom?: true;
	/** 内部挂点 → 人话名。皮肤写 `[data-bn="avatar"]`。 */
	hooks: Record<string, string>;
}

const AUTHOR_HOOKS = {
	avatar: "头像",
	name: "名字",
	time: "时间",
} as const;

/** 四种可编辑卡共用的分割线。 */
const DIVIDER_BLOCK: CardSkinBuiltinBlock = { label: "分割线", atom: true, hooks: {} };

/**
 * 内置块目录:每种卡有哪些块、每块内部有哪些挂点。**块名与挂点名是对外 API。**
 *
 * 复合块的渲染逻辑就是今天模板里那一段,原样搬;原子块是从复合块里抠出来的单件,
 * 让皮肤能把头像和名字分开摆(ADR-0014 决策 8)。
 */
export const CARD_SKIN_BUILTIN_BLOCKS: Record<
	CardSkinKind,
	Record<string, CardSkinBuiltinBlock>
> = {
	live: {
		cover: { label: "封面图", hooks: { image: "封面", status: "状态角标" } },
		header: { label: "主播信息", hooks: AUTHOR_HOOKS },
		title: { label: "直播标题", hooks: {} },
		data: {
			label: "直播数据",
			hooks: { row: "顶行", popularity: "人气 / 点赞", area: "分区", fans: "粉丝行" },
		},
		desc: { label: "简介", hooks: {} },
		divider: DIVIDER_BLOCK,
		avatar: { label: "头像", atom: true, hooks: {} },
		name: { label: "主播名", atom: true, hooks: {} },
		time: { label: "开播时间", atom: true, hooks: {} },
		// 数据区的三件(ADR-0014 决策 16 的 🔗):`showPopularity` / `showArea` / `showFans`
		// 三个显隐开关管的是**复合块内部的一行**,块级的 `showIf` 够不着 —— 所以不留开关,
		// 把那三件也拆成原子块,用户想少显示哪件就把哪块从版式里删掉。
		popularity: { label: "人气 / 点赞", atom: true, hooks: {} },
		area: { label: "分区", atom: true, hooks: {} },
		fans: { label: "粉丝行", atom: true, hooks: {} },
	},
	dynamic: {
		header: { label: "头部信息", hooks: AUTHOR_HOOKS },
		content: {
			label: "动态正文",
			hooks: {
				topic: "话题行",
				body: "正文",
				pics: "图廊",
				pic: "图廊里的一张图",
				video: "视频卡",
				videoCover: "视频封面",
				videoTitle: "视频标题",
				forward: "转发的原动态",
			},
		},
		additional: {
			label: "附加内容",
			hooks: { card: "附加卡", cover: "附加卡封面", button: "按钮" },
		},
		stats: { label: "转发 / 评论 / 点赞", hooks: { item: "单项", icon: "图标" } },
		divider: DIVIDER_BLOCK,
		avatar: { label: "头像", atom: true, hooks: {} },
		name: { label: "UP 主名", atom: true, hooks: {} },
		time: { label: "发布时间", atom: true, hooks: {} },
	},
	sc: {
		amount: { label: "金额", hooks: { price: "金额数字", duration: "时长胶囊" } },
		sender: {
			label: "发送者",
			hooks: {
				avatar: "发送者头像",
				name: "发送者名牌",
				to: "「SC to」那一行",
				masterAvatar: "主播小头像",
				masterName: "主播名",
			},
		},
		message: { label: "留言", hooks: { text: "留言文本" } },
		divider: DIVIDER_BLOCK,
		avatar: { label: "发送者头像", atom: true, hooks: {} },
		name: { label: "发送者名", atom: true, hooks: {} },
	},
	guard: {
		badge: { label: "舰长徽章", atom: true, hooks: {} },
		name: {
			label: "姓名",
			hooks: {
				avatar: "头像",
				name: "用户名胶囊",
				master: "主播胶囊",
				masterAvatar: "主播小头像",
				masterName: "主播名",
			},
		},
		text: { label: "文字信息", hooks: {} },
		divider: DIVIDER_BLOCK,
		avatar: { label: "头像", atom: true, hooks: {} },
	},
	roastBoard: { body: { label: "周报榜单", hooks: {} } },
	roastSolo: { body: { label: "单人锐评", hooks: {} } },
	wordcloud: { body: { label: "弹幕词云", hooks: {} } },
};

// ---- CSS 属性白名单 -----------------------------------------------------------

/**
 * 卡片皮肤 CSS 的属性白名单。与 dashboard 皮肤那份(`apps/contract` 的
 * `SKIN_CSS_EXACT_PROPS`)**刻意不同**:那边的信条是「布局归宿主、皮肤只管观感」,
 * 这边正好相反 —— 卡片皮肤要管的就是布局(ADR-0014 决策 6、13),块间距、对齐、字号
 * 都得写得进去。出图是一张静态 PNG,没有点击面,dashboard 那几条「看不见却点得到」
 * 的顾虑在这里不成立。取网 / 执行面(`url()` / `@import` / 脚本)照旧不放行,那是清洗器
 * 的值级规矩,与名单无关。
 */
export const CARD_SKIN_CSS_EXACT_PROPS = [
	// 观感(与 dashboard 同)
	"background",
	"color",
	"opacity",
	"box-shadow",
	"text-shadow",
	"filter",
	"backdrop-filter",
	"-webkit-backdrop-filter",
	"mix-blend-mode",
	"image-rendering",
	"clip-path",
	"transform",
	"transform-origin",
	"rotate",
	"scale",
	"translate",
	"border",
	"outline",
	"border-radius",
	"content",
	// 盒与定位
	"inset",
	"top",
	"right",
	"bottom",
	"left",
	"width",
	"height",
	"min-width",
	"min-height",
	"max-width",
	"max-height",
	"position",
	"z-index",
	"padding",
	"margin",
	"box-sizing",
	"overflow",
	"aspect-ratio",
	"object-fit",
	"object-position",
	"visibility",
	"display",
	// 排布(块内部的 flex,以及块在网格里的对齐)
	"gap",
	"row-gap",
	"column-gap",
	"flex",
	"flex-direction",
	"flex-wrap",
	"flex-grow",
	"flex-shrink",
	"flex-basis",
	"order",
	"align-items",
	"align-self",
	"align-content",
	"justify-items",
	"justify-self",
	"justify-content",
	// 文字
	"font",
	"font-size",
	"font-weight",
	"font-style",
	"font-family",
	"line-height",
	"letter-spacing",
	"text-align",
	"text-decoration",
	"text-transform",
	"text-overflow",
	"white-space",
	"word-break",
	"overflow-wrap",
	"vertical-align",
] as const;

/** 前缀放行:`padding-top`、`margin-left`、`border-top-left-radius`、`background-size`…… */
export const CARD_SKIN_CSS_PROP_PREFIXES = [
	"background-",
	"border-",
	"outline-",
	"padding-",
	"margin-",
	"font-",
	"text-",
	"overflow-",
	"place-",
] as const;

// ---- 变量 -------------------------------------------------------------------

/**
 * 皮肤变量:用户在面板里调的那几样(`cardStyle`)按这些名字注进根块的 CSS 自定义属性,
 * 皮肤 CSS 里 `var(--bn-card-color-start)` 引用。**固定表**(ADR-0014 决策 16)。
 */
export const CARD_SKIN_VARIABLES = {
	colorStart: { css: "--bn-card-color-start", label: "渐变起色" },
	colorEnd: { css: "--bn-card-color-end", label: "渐变止色" },
	glassOpacity: { css: "--bn-card-glass-opacity", label: "玻璃白纱不透明度(0~1)" },
	glassBlur: { css: "--bn-card-glass-blur", label: "玻璃模糊半径(px)" },
	font: { css: "--bn-card-font", label: "字体栈" },
} as const;
export type CardSkinVariable = keyof typeof CARD_SKIN_VARIABLES;

// ---- 数据契约 ----------------------------------------------------------------

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

const AUTHOR_FIELDS = (who: string) => [
	f("up.name", "text", `${who}名`),
	f("up.face", "image", `${who}头像`),
];

/**
 * 每种卡对外承诺的字段(ADR-0014 决策 14)。**只增不删不改名。**
 * 已格式化的文本(「1.2 万」「已开播 1 小时」)直接给,占位符不带过滤器。
 * `is*` / `has*` 一律 bool,是 `showIf` 的目标。
 */
export const CARD_SKIN_FIELDS: Record<CardSkinKind, readonly CardSkinField[]> = {
	live: [
		...AUTHOR_FIELDS("主播"),
		f("live.title", "text", "直播标题"),
		f("live.area", "text", "分区"),
		f("live.time", "text", "开播时长 / 下播时间那句"),
		f("live.description", "text", "房间简介(纯文本)"),
		f("live.cover", "image", "封面(生效的那张)"),
		f("live.hasCover", "bool", "有没有封面"),
		f("live.isStreaming", "bool", "正在直播"),
		f("live.isEnded", "bool", "已下播"),
		f("stats.popularity", "text", "人气(直播中)/ 点赞(下播)"),
		f("stats.area", "text", "分区(同 live.area,给数据行用)"),
		f("stats.fans", "text", "粉丝数(直播中)/ 累计观看(下播)"),
		f("stats.fansChanged", "text", "粉丝变化(下播才有)"),
		f("stats.hasFansChanged", "bool", "有没有粉丝变化"),
	],
	dynamic: [
		...AUTHOR_FIELDS("UP 主"),
		f("up.isVip", "bool", "是大会员"),
		f("dynamic.type", "text", "动态类型(DYNAMIC_TYPE_*)"),
		f("dynamic.action", "text", "「投稿了视频」这类动作标签"),
		f("dynamic.time", "text", "发布时间"),
		f("dynamic.topic", "text", "话题"),
		f("dynamic.hasTopic", "bool", "有没有话题"),
		f("dynamic.isForward", "bool", "是转发"),
		f("dynamic.hasAdditional", "bool", "有没有附加内容(预约 / 商品…)"),
		f("dynamic.hasVideo", "bool", "带视频卡"),
		f("dynamic.hasPics", "bool", "带图"),
		f("video.title", "text", "视频标题"),
		f("video.cover", "image", "视频封面"),
		f("video.duration", "text", "视频时长"),
		f("video.views", "text", "播放量"),
		f("video.danmaku", "text", "弹幕数"),
		f("pics.count", "number", "图片张数"),
		f("pics.first", "image", "第一张图"),
		f("stats.forward", "text", "转发数"),
		f("stats.comment", "text", "评论数"),
		f("stats.like", "text", "点赞数"),
	],
	sc: [
		f("sender.name", "text", "发送者名"),
		f("sender.face", "image", "发送者头像"),
		f("master.name", "text", "主播名"),
		f("master.face", "image", "主播头像"),
		f("sc.price", "text", "金额(带货币符号)"),
		f("sc.priceValue", "number", "金额数字"),
		f("sc.duration", "text", "留言时长"),
		f("sc.level", "number", "价位档(0~5)"),
		f("sc.text", "text", "留言"),
	],
	guard: [
		f("user.name", "text", "上舰用户名"),
		f("user.face", "image", "上舰用户头像"),
		f("user.isAdmin", "bool", "是房管"),
		f("master.name", "text", "主播名"),
		f("master.face", "image", "主播头像"),
		f("guard.level", "number", "舰长等级(1 总督 / 2 提督 / 3 舰长)"),
		f("guard.levelName", "text", "舰长 / 提督 / 总督"),
		f("guard.badge", "image", "徽章图"),
		f("guard.text", "text", "文字信息那句"),
	],
	roastBoard: [f("master.name", "text", "主播名"), f("report.days", "number", "统计天数")],
	roastSolo: [
		f("up.name", "text", "UP 主名"),
		f("up.face", "image", "UP 主头像"),
		f("report.days", "number", "统计天数"),
	],
	wordcloud: [f("master.name", "text", "主播名"), f("master.face", "image", "主播头像")],
};

const FIELD_PATH_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

// ---- schema -----------------------------------------------------------------

const GridSchema = z.object({
	row: z.number().int().min(1).max(CARD_SKIN_LIMITS.maxRows),
	column: z.number().int().min(1).max(CARD_SKIN_LIMITS.columns),
	span: z.number().int().min(1).max(CARD_SKIN_LIMITS.columns),
	/** 跨几行,缺省 1(上舰卡的徽章要跨两行)。 */
	rowSpan: z.number().int().min(1).max(CARD_SKIN_LIMITS.maxRows).optional(),
});

/**
 * 一列的宽度。缺省(整份 `columns` 不写)= 12 列全 `{ fr: 1 }`,也就是 12 等分。
 *
 * 定宽列(`px`)是为**定尺寸的图**留的:上舰卡的徽章是 175px 的方图,12 等分里落不到
 * 整数列(400 / 12 × 4 = 133.33),只有定宽列能把它复刻到像素(ADR-0014 决策 13)。
 * 两位小数是必要的 —— 175 / 4 = 43.75。
 */
const CardSkinColumnSchema = z.union([
	z.object({ fr: z.number().int().min(1).max(CARD_SKIN_LIMITS.columns) }).strict(),
	z
		.object({
			px: z.number().min(1).max(CARD_SKIN_LIMITS.width.max).multipleOf(0.01, "px 列最多两位小数"),
		})
		.strict(),
]);
export type CardSkinColumn = z.infer<typeof CardSkinColumnSchema>;

const BLOCK_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * 包内资产的引用:`asset:assets/<文件>`。形状与 server 落盘的名字同构(一级 `assets/`、
 * 小写、无 `..`);扩展名白名单与「包里真有没有」归 server 装包那道门,这里只把路径穿越
 * 与外网写法挡在 schema 层。
 */
const ASSET_REF_RE = /^asset:assets\/[a-z0-9._-]+$/;
const assetRef = z
	.string()
	.regex(ASSET_REF_RE, "资产引用只认 asset:assets/<文件> 形式")
	.refine((v) => !v.includes(".."), "资产引用不许带 ..");

/** CSS 变量名(`--bn-asset-<名>` 的那截 `<名>`)。 */
const ASSET_VAR_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * 资产变量表:变量名 → 包内资产。渲染器把每项注成该元素上的 `--bn-asset-<名>`(值是
 * data URL),作者在 CSS 里 `var(--bn-asset-<名>)` 自己用 —— 这是 `url()` 一律拒收之下
 * 资产进 CSS 的**唯一**一条路(ADR-0014 决策 13 的 🔗)。
 */
const AssetVarsSchema = z
	.record(
		z.string().regex(ASSET_VAR_RE, "资产变量名只准小写字母、数字、连字符,32 字以内"),
		assetRef,
	)
	.refine(
		(m) => Object.keys(m).length <= CARD_SKIN_LIMITS.maxAssetVars,
		`一张 assets 表最多 ${CARD_SKIN_LIMITS.maxAssetVars} 项`,
	);
export type CardSkinAssetVars = z.infer<typeof AssetVarsSchema>;

const cssField = z
	.string()
	.max(CARD_SKIN_LIMITS.maxCssBytes, `css 超过 ${CARD_SKIN_LIMITS.maxCssBytes / 1024}KB`)
	.optional();

const BlockBaseSchema = z.object({
	id: z.string().regex(BLOCK_ID_RE, "块 id 只准小写字母、数字、连字符,32 字以内"),
	grid: GridSchema,
	/** 字段路径,真值才画;字段必须在该卡种的 `CARD_SKIN_FIELDS` 里(装包时对表)。 */
	showIf: z.string().regex(FIELD_PATH_RE, "showIf 只认 a.b.c 形式的字段路径").optional(),
	css: cssField,
	/** 这个块的资产变量(注在 wrapper 上)。 */
	assets: AssetVarsSchema.optional(),
});

/**
 * 块与包一律 `.strict()`:皮肤包是要被人手写、被人分享的格式,`showif` 这种笔误静默剥掉
 * 比报错贵得多;将来加字段靠 `schemaVersion` 递增,不靠老版本默默忽略。
 */
const BuiltinBlockSchema = BlockBaseSchema.extend({
	kind: z.literal("builtin"),
	builtin: z.string(),
}).strict();

const CustomBlockSchema = BlockBaseSchema.extend({
	kind: z.literal("custom"),
	/** 受限 HTML 子集(清洗在 server),文本里可写 `{a.b.c}` 占位符。 */
	html: z
		.string()
		.max(CARD_SKIN_LIMITS.maxHtmlBytes, `html 超过 ${CARD_SKIN_LIMITS.maxHtmlBytes / 1024}KB`),
}).strict();

export const CardSkinBlockSchema = z.discriminatedUnion("kind", [
	BuiltinBlockSchema,
	CustomBlockSchema,
]);
export type CardSkinBlock = z.infer<typeof CardSkinBlockSchema>;
export type CardSkinBuiltinBlockRef = z.infer<typeof BuiltinBlockSchema>;
export type CardSkinCustomBlock = z.infer<typeof CustomBlockSchema>;

export const CardSkinCardSchema = z
	.object({
		width: z.number().int().min(CARD_SKIN_LIMITS.width.min).max(CARD_SKIN_LIMITS.width.max),
		gap: z
			.object({
				row: z
					.number()
					.int()
					.min(CARD_SKIN_LIMITS.gap.min)
					.max(CARD_SKIN_LIMITS.gap.max)
					.optional(),
				column: z
					.number()
					.int()
					.min(CARD_SKIN_LIMITS.gap.min)
					.max(CARD_SKIN_LIMITS.gap.max)
					.optional(),
			})
			.optional(),
		/**
		 * 12 列各自的宽度。不写 = 12 等分;写就得**恰好 12 项**(列数是固定的,块的
		 * `column` / `span` 都按它算)。
		 */
		columns: z
			.array(CardSkinColumnSchema)
			.length(CARD_SKIN_LIMITS.columns, `columns 必须恰好 ${CARD_SKIN_LIMITS.columns} 项`)
			.optional(),
		/** 根块两层的 CSS(清洗后每条选择器以 `[data-bn="frame"]` / `[data-bn="glass"]` 起头)。 */
		css: cssField,
		/** 这张卡外框的资产变量(注在 frame 上)。 */
		assets: AssetVarsSchema.optional(),
		blocks: z
			.array(CardSkinBlockSchema)
			.max(CARD_SKIN_LIMITS.maxBlocks, `一张卡最多 ${CARD_SKIN_LIMITS.maxBlocks} 块`),
	})
	.strict();
export type CardSkinCard = z.infer<typeof CardSkinCardSchema>;

/** 皮肤自带的变量默认值(用户面板里改的覆盖它)。`backgroundImage` 是包内资产名。 */
export const CardSkinVariableDefaultsSchema = z
	.object({
		colorStart: z.string().max(64).optional(),
		colorEnd: z.string().max(64).optional(),
		glassOpacity: z.number().min(0).max(1).optional(),
		glassClear: z.boolean().optional(),
		font: z.string().max(200).optional(),
		backgroundImage: z.string().max(80).optional(),
	})
	.strict();
export type CardSkinVariableDefaults = z.infer<typeof CardSkinVariableDefaultsSchema>;

/** CSS `font-family` 名:能不加引号地出现在 `@font-face` 与 `font-family` 里的那种。 */
const FONT_FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/;

/**
 * 皮肤自带的字体:渲染器按每项注一条 `@font-face{font-family:<family>;src:url(<data URL>)}`,
 * 皮肤 CSS 里直接写 `font-family:<family>`。`url()` 在皮肤 CSS 里一律拒收,字体只能从这条
 * 结构化的路进。
 */
export const CardSkinFontSchema = z
	.object({
		family: z
			.string()
			.regex(FONT_FAMILY_RE, "字体名只准字母、数字、空格、下划线、连字符,60 字以内"),
		asset: assetRef,
	})
	.strict();
export type CardSkinFont = z.infer<typeof CardSkinFontSchema>;

export const CardSkinManifestSchema = z
	.object({
		schemaVersion: z.literal(CARD_SKIN_SCHEMA_VERSION, {
			error: `schemaVersion 必须是 ${CARD_SKIN_SCHEMA_VERSION}`,
		}),
		dataVersion: z.number().int().min(1),
		name: z.string().min(CARD_SKIN_LIMITS.name.min).max(CARD_SKIN_LIMITS.name.max),
		author: z.string().max(CARD_SKIN_LIMITS.author.max).optional(),
		description: z.string().max(CARD_SKIN_LIMITS.description.max).optional(),
		variables: CardSkinVariableDefaultsSchema.optional(),
		/** 按卡种的变量默认值,叠在上面那份之上。 */
		variablesByKind: z.partialRecord(CardSkinKindSchema, CardSkinVariableDefaultsSchema).optional(),
		/** 皮肤自带的字体(family 全表唯一,装包时对包内资产)。 */
		fonts: z
			.array(CardSkinFontSchema)
			.max(CARD_SKIN_LIMITS.maxFonts, `fonts 最多 ${CARD_SKIN_LIMITS.maxFonts} 款`)
			.optional(),
		cards: z.partialRecord(CardSkinKindSchema, CardSkinCardSchema),
	})
	.strict();
export type CardSkinManifest = z.infer<typeof CardSkinManifestSchema>;

export type ParseCardSkinResult =
	| { ok: true; manifest: CardSkinManifest }
	| { ok: false; errors: string[] };

/**
 * 装包 / 保存的门:形状(zod)+ 跨字段规矩(id 唯一、内置块名在目录里、网格不越界、
 * showIf 指向该卡种真有的字段)。**不清洗 CSS / HTML**,那是 server 清洗器的事。
 */
export function parseCardSkin(raw: unknown): ParseCardSkinResult {
	const parsed = CardSkinManifestSchema.safeParse(raw);
	if (!parsed.success) {
		return {
			ok: false,
			errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
		};
	}
	const m = parsed.data;
	const errors: string[] = [];
	const families = new Set<string>();
	m.fonts?.forEach((f, i) => {
		if (families.has(f.family)) errors.push(`fonts[${i}]: 字体名「${f.family}」重复`);
		families.add(f.family);
	});
	for (const kind of CARD_SKIN_KINDS) {
		const card = m.cards[kind];
		if (!card) continue;
		// 定宽列吃光卡宽 → fr 列全塌成 0,块要么互相叠、要么整列看不见。宁可拒收:
		// 这种包在编辑器里也画不出人想要的样子,进门再报比进门前报难查得多。
		if (card.columns) {
			const px = card.columns.reduce((sum, c) => sum + ("px" in c ? c.px : 0), 0);
			if (px >= card.width) {
				errors.push(
					`cards.${kind}.columns: 定宽列合计 ${px}px 不小于卡宽 ${card.width}px,等分列没地方站`,
				);
			}
		}
		const ids = new Set<string>();
		const fields = new Set(CARD_SKIN_FIELDS[kind].map((x) => x.path));
		const catalogue = CARD_SKIN_BUILTIN_BLOCKS[kind];
		card.blocks.forEach((b, i) => {
			const at = `cards.${kind}.blocks[${i}]`;
			if (ids.has(b.id)) errors.push(`${at}: 块 id「${b.id}」重复`);
			ids.add(b.id);
			if (b.grid.column + b.grid.span - 1 > CARD_SKIN_LIMITS.columns) {
				errors.push(
					`${at}.grid: 第 ${b.grid.column} 列起跨 ${b.grid.span} 列越过了 ${CARD_SKIN_LIMITS.columns} 列`,
				);
			}
			if (b.grid.row + (b.grid.rowSpan ?? 1) - 1 > CARD_SKIN_LIMITS.maxRows) {
				errors.push(`${at}.grid: 行数越过了 ${CARD_SKIN_LIMITS.maxRows}`);
			}
			if (b.kind === "builtin" && !(b.builtin in catalogue)) {
				errors.push(`${at}: ${kind} 卡没有叫「${b.builtin}」的内置块`);
			}
			if (b.showIf && !fields.has(b.showIf)) {
				errors.push(`${at}.showIf: ${kind} 卡的契约里没有字段「${b.showIf}」`);
			}
		});
	}
	return errors.length ? { ok: false, errors } : { ok: true, manifest: m };
}

// ---- 默认皮肤 ----------------------------------------------------------------

/** 默认皮肤的 id,保留字;内置只读,要改先复制一份。 */
export const DEFAULT_CARD_SKIN_ID = "default";

/**
 * 皮肤 id:`default` 是内置那份,其余由 server 的皮肤库生成(时间戳 36 进制 + 随机 hex,
 * 与 dashboard 皮肤同款)。它是落盘目录名与配置里的引用键,所以在 schema 这一步就把
 * 路径穿越那类字符挡在门外。
 */
export const CardSkinIdSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "皮肤 id 只准小写字母、数字、连字符");

type B = CardSkinBlock;
const stack = (
	blocks: Array<[builtin: string, paddingTop?: number, id?: string]>,
	extra: Partial<Pick<CardSkinBuiltinBlockRef, "css">> = {},
): B[] =>
	blocks.map(([builtin, pt, id], i) => ({
		id: id ?? builtin,
		kind: "builtin",
		builtin,
		grid: { row: i + 1, column: 1, span: 12 },
		...(pt !== undefined ? { css: `[data-bn="self"]{padding-top:${pt}px}` } : {}),
		...extra,
	}));

/**
 * 复刻今天的外观:块顺序与块间距逐项照抄 `DEFAULT_CARD_LAYOUT`(`card-layout.ts`),
 * 外框参数走内置块自己的默认(与变量),所以 `css` 只写块间距。
 *
 * 上舰卡是今天唯一的二维版式:内容列(姓名 / 文字)在左八列、徽章在右四列跨两行,
 * 玻璃层固定高、两行上下分布(`align-content:space-between` 复刻原来的 `justify-between`)。
 * 徽章那四列是**定宽**的 —— 原来的徽章图就是 175px 见方,12 等分给不出这个数;内容块
 * 再补回原来内容列的内边距(`px-[16px] py-[12px]`),两处合起来才做到与旧版式逐像素相同。
 * 首 / 末块的 `align-self` 是把原来 `justify-between` 的「首块贴顶、末块贴底」钉死:
 * 徽章那一格占满卡高,会把两行撑开,不钉的话块会跟着行一起被挪。
 */
export const DEFAULT_CARD_SKIN: CardSkinManifest = {
	schemaVersion: CARD_SKIN_SCHEMA_VERSION,
	dataVersion: CARD_DATA_VERSION,
	name: "默认",
	description: "Bilibili-Notify 出厂的卡片外观。",
	cards: {
		live: {
			width: 600,
			blocks: stack([
				["cover"],
				["header", 14],
				["title", 10],
				["divider", 10, "divider-1"],
				["data", 10],
				["desc", 16],
			]),
		},
		dynamic: {
			width: 600,
			blocks: stack([
				["header"],
				["divider", 12, "divider-1"],
				["content", 12],
				["additional", 12],
				["divider", 12, "divider-2"],
				["stats", 12],
			]),
		},
		sc: {
			width: 290,
			blocks: stack([["amount"], ["divider", 15, "divider-1"], ["sender", 12], ["message", 12]]),
		},
		guard: {
			width: 430,
			columns: [
				...Array.from({ length: 8 }, () => ({ fr: 1 })),
				...Array.from({ length: 4 }, () => ({ px: 43.75 })),
			],
			css: '[data-bn="glass"]{height:190px;align-content:space-between}',
			blocks: [
				{
					id: "name",
					kind: "builtin",
					builtin: "name",
					grid: { row: 1, column: 1, span: 8 },
					css: '[data-bn="self"]{padding:12px 16px 0px;align-self:start}',
				},
				{
					id: "text",
					kind: "builtin",
					builtin: "text",
					grid: { row: 2, column: 1, span: 8 },
					css: '[data-bn="self"]{padding:0px 16px 12px;align-self:end}',
				},
				{
					id: "badge",
					kind: "builtin",
					builtin: "badge",
					grid: { row: 1, column: 9, span: 4, rowSpan: 2 },
					css: '[data-bn="self"]{height:190px;display:flex;align-items:center;align-self:start}',
				},
			],
		},
		roastBoard: { width: 600, blocks: stack([["body"]]) },
		roastSolo: { width: 430, blocks: stack([["body"]]) },
		wordcloud: { width: 720, blocks: stack([["body"]]) },
	},
};
