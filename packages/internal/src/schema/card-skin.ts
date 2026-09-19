import { z } from "zod";

/**
 * 卡片皮肤包(ADR-0014)—— 推送卡片图的皮肤:一份 JSON 描述七种卡各自的**网格、块与
 * 每块的 CSS**,由 `packages/image` 按它装配出图。这里是它的**契约**:什么样的包能进门、
 * 有哪些内置块与挂点、模版能引用哪些字段、变量叫什么名。
 *
 * 三条纪律:
 * - **挂点名、字段路径、变量名都是对外 API,只增不改不删**(第三方皮肤会写死它们)。
 * - 这层只量长度不看内容:CSS 与自定义 HTML 的清洗归 server 的清洗器,渲染器只吃洗过的。
 * - 这套格式必须能**复刻出厂那套外观**(`DEFAULT_CARD_SKIN`)—— 它是
 *   格式够不够用的验收门,也是改过版式的存量用户迁移后零感知的依据。出厂默认皮肤
 *   (`DEFAULT_CARD_SKIN`)2026-09-18 起改用原子块拼,外观允许几个像素的出入(决策 8 的 🔗)。
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

import {
	CARD_PREVIEW_SCENES,
	CARD_SKIN_BUILTIN_BLOCKS,
	CARD_SKIN_FIELDS,
	CARD_SKIN_FRAME_HOOKS,
	CARD_SKIN_KIND_NAMES,
	CARD_SKIN_KINDS,
	CARD_SKIN_KNOB_KEY_RE,
	CARD_SKIN_KNOB_LIMITS,
	CARD_SKIN_KNOB_UNITS,
	CARD_SKIN_LIMITS,
	CARD_SKIN_SELF_HOOK,
	CARD_SKIN_UPLOAD_PREFIX,
	type CardSkinBuiltinBlock,
	type CardSkinField,
	type CardSkinFieldType,
	type CardSkinFrameHook,
	type CardSkinGrid,
	type CardSkinKind,
	type CardSkinKnobUnit,
	cardSkinBytes,
	type PreviewScene,
	parseCardSkinFontKnobValue,
	parseCardSkinImageKnobValue,
	resolvePreviewScene,
	rowMapOf,
} from "../constants.js";

export type { CardSkinGrid, CardSkinKind, PreviewScene };
// 七种卡与预览场景表都住零依赖的 `constants.ts`:面板(apps/web)要拿它们画那排卡种 tab
// 与那排场景按钮,而从根入口取值会把 zod 整张 schema 图拽进前端 bundle
// (`internal-entry-conformance.test.ts` 钉着这条)。这里原样再导出,后端与出图端照旧从
// 根入口拿。
export {
	CARD_PREVIEW_SCENES,
	CARD_SKIN_KIND_NAMES,
	CARD_SKIN_KINDS,
	resolvePreviewScene,
	rowMapOf,
};
export const CardSkinKindSchema = z.enum(CARD_SKIN_KINDS);

export type { CardSkinBuiltinBlock };
// 上限与内置块目录同样住 `constants.ts`(理由同上:编辑器要照它们画控件与块名)。
export { CARD_SKIN_BUILTIN_BLOCKS, CARD_SKIN_LIMITS, cardSkinBytes };

// ---- 挂点 -------------------------------------------------------------------

export type { CardSkinFrameHook };
// 挂点名住零依赖的 `constants.ts`(理由同块目录:编辑器要照它们给作者列「这块能挂哪些
// 选择器」,而从根入口取值会把 zod 拽进前端 bundle)。这里原样再导出。
export { CARD_SKIN_FRAME_HOOKS, CARD_SKIN_SELF_HOOK };

// ---- 变量 -------------------------------------------------------------------

/**
 * 皮肤变量:**固定表**(ADR-0014 决策 16),注进根块的 CSS 自定义属性。
 *
 * 表里只剩两类:**用户的资产**(按 UP 单设的背景图 —— 换皮肤它还跟着人走)与**数据**
 * (SC / 上舰的档位色)。字体原先也在这张表里,但渲染器从没注过 `--bn-card-font`
 * (字体经 `renderCard` 的 `font` 进来,皮肤要调字体走字体旋钮),那一项已删。可调的观感一律归旋钮({@link CARD_SKIN_KNOB_LIMITS}),由皮肤
 * 自己声明 —— 2026-09-14 主人推翻「皮肤不带自定义旋钮」之后,玻璃白纱 / 模糊这两项
 * 也从这张表退成了默认皮肤自己的旋钮:赛博朋克那类没有玻璃层的皮肤,不该在面板上
 * 挂两根拧了没反应的滑杆。
 *
 * 渐变起 / 止色**不在表里**(决策 15 的 🔗):那两个色只喂外框底,归皮肤 CSS 自己写;
 * 默认皮肤把它俩做成了旋钮,所以用户照样调得动。
 */
export const CARD_SKIN_VARIABLES = {
	/** 用户设了背景图才注(值是 `url("data:…")`);皮肤 CSS 用 `var(--bn-card-bg-image, <渐变>)` 兜底。 */
	bgImage: {
		css: "--bn-card-bg-image",
		label:
			"用户背景图(有才注;值是完整的一层 `url(…) center / cover`,可直接叠进 background 的层列表)",
	},
	/** SC 按价位、上舰按舰长等级的档位色,只这两种卡有。 */
	tierColor: { css: "--bn-card-tier-color", label: "档位色(SC / 上舰)" },
	tierColorEnd: { css: "--bn-card-tier-color-end", label: "档位色止色(SC / 上舰)" },
} as const;

/**
 * 默认皮肤自己声明的那四枚旋钮的 key。**对外 API**:第三方皮肤想复刻默认皮肤的可调项
 * 就照抄这几个名字,存量用户的旋钮覆盖也按这几个键存。
 */
export const DEFAULT_SKIN_KNOB_KEYS = {
	gradientStart: "gradient-start",
	gradientEnd: "gradient-end",
	glassOpacity: "glass-opacity",
	glassBlur: "glass-blur",
	/**
	 * 字体与壁纸(2026-09-14 主人拍板)。从前是 `cardStyle.font` / `backgroundImages` 那两项
	 * **全局**设置,而用了皮肤多半不生效 —— 皮肤自己写一句 `font-family`、自己画一层背景,
	 * 面板上那两个控件就成了摆设,却照样让人调。退成旋钮之后:皮肤声明了才有得调。
	 */
	font: "font",
	wallpaper: "wallpaper",
} as const;

/**
 * **出厂渐变**:直播 / 动态 / 锐评两张 / 词云的外框底色。从前是 `cardStyle.cardColorStart /
 * cardColorEnd` 两个用户配置项,现在写死在这儿、由默认皮肤的外框 CSS 画出来(ADR-0014
 * 决策 15 的 🔗)。存量用户改过的颜色由开机迁移派生成一套皮肤,不从这条路走。
 */
export const DEFAULT_CARD_GRADIENT = ["#e0c3fc", "#8ec5fc"] as const;

/**
 * 一张卡外框的底色规则(ADR-0014 决策 15 的 🔗:底色归皮肤 CSS,外框不再 inline)。
 * 与旧 `frameBg` 同一条逻辑:有背景图就整张换成图(变量的值自带 `center / cover`,所以
 * 兜底的渐变**不能**再跟尺寸 —— 给渐变加 `center / cover` 会改变它的光栅抖动,像素门 14 张红),
 * 没有就画渐变。图与字体都吃**旋钮**变量(2026-09-14):`--bn-card-bg-image` 那条老路
 * 随 `cardStyle.backgroundImages` 一起退役,详见 {@link CARD_SKIN_VARIABLES}。
 *
 * 字体那句的兜底是 `inherit` —— 没拧过时与「这条规则不存在」等价(照旧继承页面那层
 * `font-family`),像素上一模一样。
 *
 * ⚠️ 生成的字面量必须是 css-tree `generate` 的规范形态(逗号后不留空格),默认皮肤要
 * 一字不改地过清洗器那道门(`apps/server` 的 `default-skin-*.test.ts` 钉着)。
 */
export const cardSkinFrameBgRule = (start: string, end: string): string =>
	`[data-bn="frame"]{background:var(--bn-knob-${DEFAULT_SKIN_KNOB_KEYS.wallpaper},linear-gradient(to right bottom,${start},${end}));font-family:var(--bn-knob-${DEFAULT_SKIN_KNOB_KEYS.font},inherit)}`;

/** 默认皮肤里那条用户渐变规则。迁移换色时**替换**它,不另加一条(两条 background 会打架)。 */
export const DEFAULT_FRAME_BG_RULE = cardSkinFrameBgRule(
	`var(--bn-knob-${DEFAULT_SKIN_KNOB_KEYS.gradientStart},${DEFAULT_CARD_GRADIENT[0]})`,
	`var(--bn-knob-${DEFAULT_SKIN_KNOB_KEYS.gradientEnd},${DEFAULT_CARD_GRADIENT[1]})`,
);
const FRAME_BG_USER = DEFAULT_FRAME_BG_RULE;

/**
 * 默认皮肤各卡玻璃层的规则(外框在皮肤路径不再 inline 白纱,见 `blocks/frames.tsx` 的
 * `ownGlass`)。白纱与模糊吃两枚**旋钮**变量;其余(阴影 / 内边距 / 最小宽)是各卡原来
 * inline 的那几句,逐值照抄。写成 css-tree `generate` 的规范形态(`.12` 不写 `0.12`),
 * 装包门那条「默认皮肤一字不改地过门」钉着。
 *
 * ⚠️ **兜底值按卡种各写各的**,不能共用一个数:白纱基线本来就是三档(直播 / 动态 /
 * 词云 .82、SC / 上舰 .75、锐评两张 .86)。从前三档由变量注入,CSS 里共用一句;现在
 * 「没拧过就不注」,三档全靠这里的兜底 —— 写成同一个数,五张卡的像素当场变。
 */
const glassBase = (opacity: string): string =>
	`background:rgba(255,255,255,var(--bn-knob-${DEFAULT_SKIN_KNOB_KEYS.glassOpacity},${opacity}));backdrop-filter:blur(var(--bn-knob-${DEFAULT_SKIN_KNOB_KEYS.glassBlur},10px))`;
const GLASS_SHADOW = "box-shadow:0 4px 16px rgba(0,0,0,.12)";
const GLASS_LIVE = `[data-bn="glass"]{${glassBase(".82")};${GLASS_SHADOW};min-width:360px;padding-top:14px;padding-bottom:10px}`;
const GLASS_DYNAMIC = `[data-bn="glass"]{${glassBase(".82")};${GLASS_SHADOW};padding-top:14px;padding-bottom:12px}`;
/** SC / 上舰的阴影在 class 上(`shadow-[…]`),这里只管白纱与模糊。 */
const GLASS_PLAIN = `[data-bn="glass"]{${glassBase(".75")}}`;
const GLASS_ROAST = `[data-bn="glass"]{${glassBase(".86")};${GLASS_SHADOW}}`;
/** 词云与锐评两张共用版式,白纱基线却是 .82 那一档 —— 规则同形、兜底不同。 */
const GLASS_WORDCLOUD = `[data-bn="glass"]{${glassBase(".82")};${GLASS_SHADOW}}`;
const FRAME_BG_TIER = cardSkinFrameBgRule(
	"var(--bn-card-tier-color)",
	"var(--bn-card-tier-color-end)",
);
export type CardSkinVariable = keyof typeof CARD_SKIN_VARIABLES;

// ---- 旋钮 -------------------------------------------------------------------

/** 旋钮的 CSS 变量名。**对外 API**,只增不改。 */
export const cardSkinKnobVar = (key: string): string => `--bn-knob-${key}`;

/**
 * 颜色:**只认 3 位 / 6 位 hex**(2026-09-14 主人拍板收紧)。
 *
 * 判据是**与面板对齐**:取色器 `TColor` 只吐 `#rgb` / `#rrggbb`,契约从前还收命名色与
 * `rgb()` 族 —— 皮肤把 default 写成 `tomato` 时,面板的文本框就以「格式不对」的样子摆着
 * (点一下色块能换成 hex,功能是通的,但看上去像坏了)。收紧之后作者**装包当场报错**,
 * 比默默显示怪样早得多;另一条路(面板造一张命名色翻译表)得跟着 CSS 规范走,是长期负担。
 *
 * 带透明度的 8 位 hex 一并不收 —— 面板那个文本框同样读不了。半透明走
 * `color-mix(in srgb,var(--bn-knob-x,#hex) 35%,transparent)`:它过得了清洗器且零告警,
 * 是这套旋钮里派生半透明色的唯一做法(`rgba()` 读不了变量)。
 */
const KNOB_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * 下拉候选 / 开关两端的字面量。允许的字符集**不含** `;` `{` `}` `:` `"` `'` 与反斜杠:
 * 值最后注成 `--bn-knob-x:<值>`,一个 `;` 就是一条凭空多出来的声明,一个 `}` 就是
 * 跳出这条规则、接着写任意选择器。反斜杠是 CSS 转义,在 tokenizer 里**先于** ident
 * 判定解开(`\75 rl(` 到浏览器手上就是 `url(`),所以整类拒掉,与清洗器那头同口径。
 */
const KNOB_VALUE_RE = /^[A-Za-z0-9#%.,()/ _-]+$/;

/**
 * 值里不准出现的函数。`url(` / `image-set(` / `src(` 是取网面;`element(` / `expression(`
 * 是执行面;`attr(` 能把 DOM 上别处的字符串读进来;`var(` 挡的是自引用套娃
 * (`--bn-knob-a:var(--bn-knob-b)`)—— 与 `apps/server` 清洗器的 `FORBIDDEN_VALUE` 同源,
 * 多挡后两个。
 */
const KNOB_VALUE_DENY = ["url(", "image-set(", "element(", "expression(", "src(", "attr(", "var("];

/** 一个字面量能不能进(下拉候选 / 开关两端)。返回原因或 null。 */
function knobValueReason(raw: string): string | null {
	if (raw.length === 0 || raw.length > CARD_SKIN_KNOB_LIMITS.value.max) {
		return `值长度要在 1~${CARD_SKIN_KNOB_LIMITS.value.max} 之间`;
	}
	if (!KNOB_VALUE_RE.test(raw)) return "值含分号 / 大括号 / 引号 / 反斜杠这类能越出声明的字符";
	const flat = raw.toLowerCase().replace(/\s+/g, "");
	for (const bad of KNOB_VALUE_DENY) {
		if (flat.includes(bad)) return `值含 ${bad.slice(0, -1)}()`;
	}
	return null;
}

const knobValue = z.string().refine((v) => knobValueReason(v) === null, {
	error: (iss) => knobValueReason(iss.input as string) ?? "值不合法",
});
const knobKey = z
	.string()
	.max(CARD_SKIN_KNOB_LIMITS.key.max)
	.regex(CARD_SKIN_KNOB_KEY_RE, "旋钮 key 只准小写字母起头的 kebab(如 accent / glass-opacity)");
const knobLabel = z.string().min(1).max(CARD_SKIN_KNOB_LIMITS.label.max);

export const CardSkinKnobSchema = z.discriminatedUnion("type", [
	z
		.object({
			key: knobKey,
			label: knobLabel,
			type: z.literal("color"),
			default: z.string().regex(KNOB_COLOR_RE, "颜色只准 3 位 / 6 位 hex(半透明走 color-mix)"),
		})
		.strict(),
	z
		.object({
			key: knobKey,
			label: knobLabel,
			type: z.literal("number"),
			default: z.number().finite(),
			min: z.number().finite(),
			max: z.number().finite(),
			step: z.number().positive().optional(),
			/** 不写 = 无单位(如玻璃不透明度这种纯比例)。 */
			unit: z.enum(CARD_SKIN_KNOB_UNITS).optional(),
		})
		.strict(),
	z
		.object({
			key: knobKey,
			label: knobLabel,
			type: z.literal("select"),
			default: knobValue,
			options: z
				.array(z.object({ value: knobValue, label: knobLabel }).strict())
				.min(1, "下拉至少要有一个候选")
				.max(
					CARD_SKIN_KNOB_LIMITS.maxOptions,
					`下拉最多 ${CARD_SKIN_KNOB_LIMITS.maxOptions} 个候选`,
				),
		})
		.strict(),
	z
		.object({
			key: knobKey,
			label: knobLabel,
			type: z.literal("switch"),
			default: z.boolean(),
			/** 开 / 关各自对应的 CSS 字面量(如 `block` / `none`)。 */
			on: knobValue,
			off: knobValue,
		})
		.strict(),
	/**
	 * 字体(2026-09-14 主人拍板):从前是 `cardStyle.font` / `fontAsset` 那一对全局设置,
	 * 而**用了皮肤就多半不生效** —— 皮肤只要自己写一句 `font-family`,面板上选的字体就被
	 * 盖掉,而面板照样让人选(赛博朋克那套正是如此)。改成旋钮之后,这一档由皮肤决定给不给:
	 * 不声明 = 面板上根本没有这个控件,不骗人。
	 *
	 * 值不是 CSS 字面量(见 {@link parseCardSkinFontKnobValue}):可能是主人传上来的字体
	 * **文件**,得由宿主读盘拼成 `@font-face` 才用得上。
	 */
	z
		.object({
			key: knobKey,
			label: knobLabel,
			type: z.literal("font"),
			/** 面板的起手位置:一个家族名(皮肤自带的那几款写这儿),空串 = 跟着兜底链。 */
			default: z.string().max(CARD_SKIN_KNOB_LIMITS.value.max),
		})
		.strict(),
	/**
	 * 图(同上):从前的 `cardStyle.backgroundImages`。值是**主人资产库里的一串 id**,
	 * 多张按推送轮换 —— 与从前那个背景图库一字不差,只是这回由皮肤声明要不要这一档。
	 *
	 * **没有 `default`**:图是主人自己的东西,皮肤起不出一个默认值来。皮肤想自带一张,
	 * 写在自己的 CSS 里当 `var(--bn-knob-<key>, …)` 的兜底 —— 那本来就是所有旋钮的真默认值
	 * 所在(`default` 从来只是面板的起手位置,不注入)。
	 */
	z
		.object({
			key: knobKey,
			label: knobLabel,
			type: z.literal("image"),
		})
		.strict(),
]);
export type CardSkinKnob = z.infer<typeof CardSkinKnobSchema>;

/** 用户拧出来的那一个值。按皮肤 id 存(ADR-0014 决策 16 的 🔗:换皮肤各留各的)。 */
export const CardSkinKnobValueSchema = z.union([
	z.string().max(CARD_SKIN_KNOB_LIMITS.value.max),
	z.number(),
	z.boolean(),
	/** 图片旋钮那一串资产 id。 */
	z.array(z.string().max(CARD_SKIN_KNOB_LIMITS.value.max)).max(CARD_SKIN_KNOB_LIMITS.maxImages),
]);
export type CardSkinKnobValue = z.infer<typeof CardSkinKnobValueSchema>;

/** 一套皮肤的旋钮覆盖:key → 值。没拧过的 key 不在里面(存覆盖不存值)。 */
export const CardSkinKnobOverridesSchema = z.record(knobKey, CardSkinKnobValueSchema);
export type CardSkinKnobOverrides = z.infer<typeof CardSkinKnobOverridesSchema>;

/**
 * 一个旋钮值的 **CSS 字面量**,不合法给 null(= 不注入)。
 *
 * 这是注入前的最后一道闸:存储里的覆盖值可能被手改过,也可能是旧包换了旋钮类型之后
 * 留下的残值。宁可不注(皮肤 CSS 的兜底生效),也不能把一个没验过的字符串写进 CSS。
 */
export function cardSkinKnobCss(knob: CardSkinKnob, value: unknown): string | null {
	switch (knob.type) {
		case "color":
			return typeof value === "string" && KNOB_COLOR_RE.test(value) ? value : null;
		case "number": {
			if (typeof value !== "number" || !Number.isFinite(value)) return null;
			if (value < knob.min || value > knob.max) return null;
			return `${value}${knob.unit ?? ""}`;
		}
		case "select":
			return typeof value === "string" && knob.options.some((o) => o.value === value)
				? value
				: null;
		case "switch":
			return typeof value === "boolean" ? (value ? knob.on : knob.off) : null;
		// 字体与图**不是纯 CSS 字面量**:一个是主人传的字体文件(要拼 `@font-face`),
		// 一个是资产 id(要读盘变成 data URL)。两档都由宿主解析完再自己注变量 ——
		// 这里回 null,免得把一个资产 id 原样写进 CSS。
		case "font":
		case "image":
			return null;
	}
}

// 这两个解析器与那个前缀住零依赖的 `constants.ts`(理由同块目录:面板要拿它们把旋钮值
// 与字体 / 图廊选择器来回翻,而从根入口取值会把 zod 拽进前端 bundle)。原样再导出。
export { CARD_SKIN_UPLOAD_PREFIX, parseCardSkinFontKnobValue, parseCardSkinImageKnobValue };

/**
 * 皮肤声明的旋钮 + 用户覆盖 → 注在外框上的那串自定义属性。
 * 没覆盖的旋钮**不出现**(`default` 不注入,见 {@link CARD_SKIN_KNOB_LIMITS} 的说明)。
 */
export function cardSkinKnobDeclarations(
	knobs: readonly CardSkinKnob[] | undefined,
	overrides: CardSkinKnobOverrides | undefined,
): string {
	if (!knobs?.length || !overrides) return "";
	let out = "";
	for (const knob of knobs) {
		if (!(knob.key in overrides)) continue;
		const css = cardSkinKnobCss(knob, overrides[knob.key]);
		if (css !== null) out += `${cardSkinKnobVar(knob.key)}:${css};`;
	}
	return out;
}

// ---- 数据契约 ----------------------------------------------------------------

export type { CardSkinField, CardSkinFieldType, CardSkinKnobUnit };
// 字段表住零依赖的 `constants.ts`(理由同块目录与挂点:编辑器要照它画 `showIf` 的候选
// 与自定义块里能写的占位符)。旋钮那三样同理 —— 编辑器要照上限画「还能加几枚」、照 key
// 的正则当场判合不合法、照单位表画那个下拉。这里原样再导出。
export { CARD_SKIN_FIELDS, CARD_SKIN_KNOB_KEY_RE, CARD_SKIN_KNOB_LIMITS, CARD_SKIN_KNOB_UNITS };

const FIELD_PATH_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

// ---- schema -----------------------------------------------------------------

const GridSchema = z.object({
	row: z.number().int().min(1).max(CARD_SKIN_LIMITS.maxRows),
	column: z.number().int().min(1).max(CARD_SKIN_LIMITS.columns),
	span: z.number().int().min(1).max(CARD_SKIN_LIMITS.columns),
	/** 跨几行,缺省 1(上舰卡的徽章要跨两行)。 */
	rowSpan: z.number().int().min(1).max(CARD_SKIN_LIMITS.maxRows).optional(),
	/**
	 * **层次** —— 两个块的列区间相交时谁压在上面。缺省不写 = 跟数组先后走(CSS 的老规矩)。
	 *
	 * ⚠️ 与手写 `z-index` 并存:块 CSS 里写 `[data-bn="self"]{z-index:5}` 一直是放行的
	 * (属性走黑名单)。**不写这个字段就一个字节都不注**,老皮肤那条路原样有效;写了才由
	 * 渲染器注成 inline,而 inline 恒压过 CSS(清洗器一律摘 `!important`)。
	 *
	 * 之所以不把它做成第 8 枚常用旋钮、而是结构化字段:**画布要按它排**,而画布不解析
	 * 块 CSS —— 留在 CSS 里的话,编辑器里看到的叠放顺序和出图对不上。
	 */
	z: z.number().int().min(CARD_SKIN_LIMITS.layer.min).max(CARD_SKIN_LIMITS.layer.max).optional(),
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

// 长度闸量 **UTF-8 字节**,不是 `.max()` 的 UTF-16 单元数 —— 后者一个汉字只记 1,
// 而退这份包的清洗器量的是字节。两把尺不一样的话,中文密集的皮肤过得了这道门,
// 存的时候才被清洗器退回来。
const cssField = z
	.string()
	.refine(
		(v) => cardSkinBytes(v) <= CARD_SKIN_LIMITS.maxCssBytes,
		`css 超过 ${CARD_SKIN_LIMITS.maxCssBytes / 1024}KB`,
	)
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
		.refine(
			(v) => cardSkinBytes(v) <= CARD_SKIN_LIMITS.maxHtmlBytes,
			`html 超过 ${CARD_SKIN_LIMITS.maxHtmlBytes / 1024}KB`,
		),
}).strict();

export const CardSkinBlockSchema = z.discriminatedUnion("kind", [
	BuiltinBlockSchema,
	CustomBlockSchema,
]);
export type CardSkinBlock = z.infer<typeof CardSkinBlockSchema>;
export type CardSkinBuiltinBlockRef = z.infer<typeof BuiltinBlockSchema>;
export type CardSkinCustomBlock = z.infer<typeof CustomBlockSchema>;

/**
 * **出血** —— 卡片四周那圈只为辉光存在的余量(2026-09-14 主人拍板)。
 *
 * 出图截的是 `html` 的 boundingBox,而 `box-shadow` / `filter` 的辉光**不参与布局**,
 * 画在卡外就被裁掉 —— 皮肤里那句 `box-shadow:0 0 28px …` 在成品里等于没写。留出这圈,
 * 辉光才有地方落。
 *
 * `size` 与 `color` **绑在一起必填**:出血那圈得有颜色,而 JPEG 没有 alpha —— 不给色
 * 就是一圈白边,暗色皮肤上比没有辉光更难看。色只收 hex,与旋钮的颜色档同一把尺子
 * ({@link KNOB_COLOR_RE}),不收 `var()` —— 这一句是渲染器拼出来的,不过清洗器那道门。
 *
 * **整个字段可以不写,不写就是没有出血**:存量皮肤与默认皮肤出的图逐字节不变。
 */
const CardSkinBleedSchema = z
	.object({
		size: z.number().int().min(CARD_SKIN_LIMITS.bleed.min).max(CARD_SKIN_LIMITS.bleed.max),
		color: z.string().regex(KNOB_COLOR_RE, "出血色只收 #rgb / #rrggbb"),
	})
	.strict();
export type CardSkinBleed = z.infer<typeof CardSkinBleedSchema>;

const CardSkinCardShapeSchema = z
	.object({
		width: z.number().int().min(CARD_SKIN_LIMITS.width.min).max(CARD_SKIN_LIMITS.width.max),
		/** 卡片四周留给辉光的余量。不写 = 没有出血,见 {@link CardSkinBleedSchema}。 */
		bleed: CardSkinBleedSchema.optional(),
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
		/**
		 * 🪦 **已退役**(ADR-0014 决策 10 的 2026-09-19 🔗)。形态覆盖 —— 一份基础版式 + 每个
		 * 形态在它上面改几块。出图端从此没有形态:块照数据画,没数据的不画、整行空的行压掉。
		 *
		 * 字段**留着不删**:这张卡是 `.strict()` 的,删了之后已经写着这一项的老皮肤会以
		 * `Unrecognized key: "variants"` 装不进来也存不下去。收进来之后由下面那道 transform
		 * 当场丢掉,谁都读不到它。
		 */
		variants: z.unknown().optional(),
	})
	.strict();

/**
 * 一张卡。**装进来的那一刻就把退役的 `variants` 摘掉**:留在结果里的话,下游(渲染器、
 * AI 工具面、编辑器)随手就能再把它读回去,而这一层已经没人认它了 —— 一个读得到、
 * 不生效的字段比没有更糟。所以口子只开在**入口**,出口那头它不存在。
 */
export const CardSkinCardSchema = CardSkinCardShapeSchema.transform(
	({ variants, ...card }) => card,
);
export type CardSkinCard = z.infer<typeof CardSkinCardSchema>;

/**
 * 🪦 **已退役**(2026-09-14 主人拍板)。皮肤自带的变量默认值 —— 旋钮出现**之前**那套
 * 「皮肤给默认值、面板覆盖它」的设计。
 *
 * 它的四个字段今天全都是旋钮({@link DEFAULT_SKIN_KNOB_KEYS}):旋钮把同一件事做得更干净
 * —— 皮肤声明控件、`default` 只是面板的起手位置、**不注入**,真默认值是皮肤 CSS 里
 * `var(--bn-knob-<key>, 兜底)` 的那个兜底。留着就是同一件事两个入口。
 *
 * 它**从来没被接进渲染**(`packages/image` 一次都没读过),所以退役不是迁移:装包 / 保存时
 * 由 `dropRetiredVariables` 丢掉,出的图一个像素都不变。
 *
 * 字段**留着不删**:清单是 `.strict()` 的,删了之后已经装着这一项的老皮肤会以
 * `Unrecognized key: "variables"` 装不进来也存不下去。
 */
export const CardSkinVariableDefaultsSchema = z
	.object({
		// 渐变起 / 止色已退役(决策 15 的 🔗):皮肤想要什么底自己在外框 CSS 里写。
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
		/** 这套皮肤自己的旋钮(面板照它生成控件)。 */
		knobs: z
			.array(CardSkinKnobSchema)
			.max(CARD_SKIN_KNOB_LIMITS.maxKnobs, `knobs 最多 ${CARD_SKIN_KNOB_LIMITS.maxKnobs} 枚`)
			.optional(),
		/** 🪦 已退役,只为让老皮肤装得进来而保留;装包 / 保存时丢弃。见 {@link CardSkinVariableDefaultsSchema}。 */
		variables: CardSkinVariableDefaultsSchema.optional(),
		/** 🪦 同上。 */
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
	const knobKeys = new Set<string>();
	m.knobs?.forEach((k, i) => {
		const at = `knobs[${i}]`;
		// 两枚同 key 的旋钮注的是同一个变量:面板画两个控件,拧哪个都被另一个盖掉。
		if (knobKeys.has(k.key)) errors.push(`${at}: 旋钮 key「${k.key}」重复`);
		knobKeys.add(k.key);
		if (k.type === "number") {
			if (k.min > k.max) errors.push(`${at}: min ${k.min} 大于 max ${k.max}`);
			else if (k.default < k.min || k.default > k.max) {
				errors.push(`${at}: 默认值 ${k.default} 不在 ${k.min}~${k.max} 之间`);
			}
		}
		if (k.type === "select" && !k.options.some((o) => o.value === k.default)) {
			errors.push(`${at}: 默认值「${k.default}」不在候选里`);
		}
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

/**
 * 一个内置块。id 默认就是块名;会出现两次的(分割线)与驼峰块名(id 只准小写 + 连字符)
 * 另给。`css` 只写这一块自己的。
 */
const at = (
	builtin: string,
	grid: CardSkinBlock["grid"],
	css?: string,
	id: string = builtin,
	/**
	 * 块里部件的规则,接在 self 那条后面。写成清洗器的规范形(`[data-bn="self"] ` 起头)——
	 * 默认皮肤要一字不改地过装包门。
	 */
	rules = "",
): B => ({
	id,
	kind: "builtin",
	builtin,
	grid,
	...(css || rules ? { css: `${css ? `[data-bn="self"]{${css}}` : ""}${rules}` } : {}),
});

/**
 * 块里一件部件(多半是块的根:`image` / `text` / `pill` / `line` …)的规则,接在 self 那条后面。
 * 这些规则就是内置块**长什么样**的全部(ADR-0014 决策 7 的 2026-09-19 🔗):渲染器只画结构,
 * 字号 / 字色 / 圆角 / 胶囊底色都在这里,一份皮肤 JSON 就是卡片的全部样子。
 */
const part = (hook: string, decls: string) => `[data-bn="self"] [data-bn="${hook}"]{${decls}}`;

/** 分割线自己:1px 高、两边各留 16px、淡淡一条。四种卡同一条。 */
const DIVIDER_LINE = part("line", "height:1px;margin:0 16px;background:rgba(0,0,0,.06)");

/** 醒目留言卡的分割线:两头透明、中间档位色的一道渐变(档位色是数据,渲染器注在变量里)。 */
const SC_LINE = part(
	"line",
	"height:1px;background:linear-gradient(to right,transparent,var(--bn-card-tier-color),transparent)",
);

/** 直播卡数据区三件(人气 / 分区 / 粉丝)共用的文字样子。 */
const DATA_TEXT = part("text", "padding:0 16px;font-size:13px;color:#666");

/** 通栏一行。 */
const full = (row: number) => ({ row, column: 1, span: CARD_SKIN_LIMITS.columns });

/**
 * 通栏、且**跨好几行**的高块(封面、图廊)。
 *
 * `rowSpan` 在这儿是块在网格里的**高度声明**(2026-09-18 主人拍板,ADR-0014 决策 6 的 🔗):
 * 真卡的行由内容撑,跨行数只是把「这块大约有多高」写进数据 —— 按编辑器画布一行 56px
 * 折算,封面 300 来像素就是 5 行。出图不受影响(中间那几行空着,高度是 0),画布却能照
 * 着画出真实的比例,而且检查器、画布、JSON 三处说的是同一个数。后面的块行号顺着往后排。
 */
const tall = (row: number, rowSpan: number) => ({ ...full(row), rowSpan });

/**
 * 两侧各一列定宽、中间十列等分。左边那列就是**头像列**:宽度 = 左内边距 + 头像 + 头像与名字
 * 的间距,名字从第 2 列起正好落在原来的位置。右边补一列同宽的,整张卡才左右对称 ——
 * 动态卡的三个互动数各占四列,居中后仍落在卡的三等分附近。
 */
const avatarColumns = (px: number): CardSkinColumn[] => [
	{ px },
	...Array.from({ length: CARD_SKIN_LIMITS.columns - 2 }, () => ({ fr: 1 })),
	{ px },
];

/** 块在格子里水平居中(块里是定宽的圆框 / 自带底色的胶囊,不居中就贴左)。 */
const CENTER = "display:flex;justify-content:center";

/**
 * 视频卡那圈灰底圆角容器 —— **没有这个元素**,它是封面 + 标题 / 简介 / 播放数四块**各带一段
 * 灰底**拼出来的(决策 8 的 2026-09-18 🔗:覆盖层与容器一律用网格 + CSS 表达,不造隐形底板块)。
 * `margin:0 16px` 让灰底与封面同宽,块自己的 `padding` 再把文字往里缩 12px。
 */
const VIDEO_BG = "background:rgba(0,0,0,.04)";
const VIDEO_INSET = `margin:0 16px;${VIDEO_BG}`;
/** 首尾两块分担上下圆角(`rounded-lg` = .5rem = 8px)。 */
const VIDEO_TOP_RADIUS = "border-radius:8px 8px 0 0";
const VIDEO_BOTTOM_RADIUS = "border-radius:0 0 8px 8px";

/**
 * 头部三件(头像 img、名字 span、时间 span)都是**行内**元素。在复合块里它们是 flex 子项,
 * 高度就是自己那一行;单独放进块的 wrapper(普通块容器)里,行盒会按继承来的字号撑高、
 * img 底下还会多出基线那一截 —— 头部整体高出好几个像素。wrapper 做成 flex 把它们块化。
 */
const HEAD = "display:flex";

/**
 * **出厂的卡片皮肤**(内置只读,id 见 {@link DEFAULT_CARD_SKIN_ID})。元信息、旋钮与外框 CSS
 * 四种可编辑卡的块**用原子块拼**(ADR-0014
 * 决策 8 的 2026-09-18 🔗):用户多半是复制默认皮肤再改,默认皮肤里拆得越细,能挪的就越多。
 * 外观与拆之前允许有几个像素的出入(主人拍板),东西一件不少由 `default-skin-atoms.test.ts` 钉着。
 *
 * 间距的规矩与旧默认一样写在块的 `padding` 上,只有两处换了地方:
 * - 动态卡的分割线**上下都留** 12px —— 分割线后面接哪一块(话题 / 正文 / 视频卡 / 互动数)
 *   说不准,间距跟着线走,后面那块就不用管;
 * - 头部的名字与时间靠 `align-self` 贴在头像两侧的中线上(旧的复合块是 flex 居中);
 * - 投稿视频那张卡拆成五块之后,外面那圈灰底圆角容器由封面与三段文字**各带一段灰底**
 *   拼出来(首尾分担圆角),间距也从容器的 `p-[12px]` 摊到各块的 `padding` 上;
 * - 图廊那块的上边距(8px)是从前正文里跟在文字后面的那一段。
 */
export const DEFAULT_CARD_SKIN: CardSkinManifest = {
	schemaVersion: CARD_SKIN_SCHEMA_VERSION,
	dataVersion: CARD_DATA_VERSION,
	name: "默认",
	description: "Bilibili-Notify 出厂的卡片外观。",
	/**
	 * 出厂那四枚旋钮。`default` 只是面板控件的起始位置,**不注入** —— 玻璃白纱那枚的
	 * 各卡兜底写在 CSS 里({@link glassBase}),一注就把三档基线塌成一档。
	 */
	knobs: [
		{
			key: DEFAULT_SKIN_KNOB_KEYS.gradientStart,
			label: "背景渐变起色",
			type: "color",
			default: DEFAULT_CARD_GRADIENT[0],
		},
		{
			key: DEFAULT_SKIN_KNOB_KEYS.gradientEnd,
			label: "背景渐变止色",
			type: "color",
			default: DEFAULT_CARD_GRADIENT[1],
		},
		{
			key: DEFAULT_SKIN_KNOB_KEYS.glassOpacity,
			label: "玻璃白纱",
			type: "number",
			default: 0.82,
			min: 0,
			max: 1,
			step: 0.01,
		},
		{
			key: DEFAULT_SKIN_KNOB_KEYS.glassBlur,
			label: "玻璃模糊",
			type: "number",
			default: 10,
			min: 0,
			max: 40,
			step: 1,
			unit: "px",
		},
		// 起手位置是空 = 跟着渲染那台机器的兜底链走(从前那句「默认(交给渲染那台机器)」)。
		{ key: DEFAULT_SKIN_KNOB_KEYS.font, label: "字体", type: "font", default: "" },
		// 图片旋钮没有 default:主人自己的图,皮肤起不出默认值来 —— 没选时外框那条规则里
		// 的渐变兜底顶上。
		{ key: DEFAULT_SKIN_KNOB_KEYS.wallpaper, label: "卡片背景图", type: "image" },
	],
	cards: {
		live: {
			width: 600,
			// 16 + 44(头像)+ 10(间距)
			columns: avatarColumns(70),
			css: `${FRAME_BG_USER}${GLASS_LIVE}`,
			blocks: [
				// **跨行在这块是真高度**(决策 6 的 2026-09-18 🔗):封面标了 `heightFromRows`,
				// 6 行 = 336px,图按 `object-fit:cover` 填满。
				//
				// 原先写的是 5 行,而那是**低报**的 —— 568 宽(600 减两边 16px 内边距)的 16:9
				// 封面自然高约 319.5px,画布上一直画矮了一行。高度变真之后取最接近的 6 行:
				// 比从前高约 16px,而且从此**不管 B 站给的是什么比例都是这个高度**(4:3 那种
				// 会被裁掉一截),换来的是卡片高度可预期。
				at("cover", tall(1, 6), "padding:0 16px", undefined, part("image", "border-radius:8px")),
				// 角标与封面同占第 1 行、层次更高:靠上靠右收成内容宽,外边距把它推到从前
				// `top-3 right-3` 的位置(右边那 28px = 封面的 16px 内边距 + 12px)。
				// **列号收到它真正占的那两列**(本机量过:角标 501–557,第 11 列 472–515、
				// 第 12 列 515–585)—— 出图一个像素都不差(右边缘由格子右沿定,而两种写法的
				// 右沿是同一条),但画布只看 JSON,声明通栏它就画一整行。
				// `HEAD`(flex)不能省 —— 角标是 inline-flex,块容器里会起一条线盒,行高的
				// 半个 leading 把它往下压 1.5px(本机量过)。
				// 胶囊的底色是数据(直播中粉 / 下播灰),渲染器注在 `--bn-live-status-color` 里。
				at(
					"status",
					{ row: 1, column: 11, span: 2, z: 1 },
					`${HEAD};align-self:start;justify-self:end;margin:12px 28px 0 0`,
					undefined,
					part(
						"pill",
						"height:24px;padding:1px 10px 0;border-radius:12px;background-color:var(--bn-live-status-color);color:#fff;font-size:12px;font-weight:700;line-height:1",
					),
				),
				// ⚠️ 从第 7 行起 —— **封面占的是 r1–r6**(跨 6 行)。封面改行数时这一摞必须跟着推,
				// 不然头像就落进封面的最后一行、半个身子压在图里(2026-09-18 栽过一次,主人指着
				// 预览说「UP 主信息已经和封面嵌到一起了」)。「没有不小心叠上的块」那条守卫
				// 现在钉着它。
				at(
					"avatar",
					{ row: 7, column: 1, span: 1, rowSpan: 2 },
					`${HEAD};padding:14px 0 0 16px;align-self:center`,
					undefined,
					part("image", "width:44px;height:44px;border-radius:9999px"),
				),
				at(
					"name",
					{ row: 7, column: 2, span: 11 },
					`${HEAD};padding-top:14px;align-self:end`,
					undefined,
					part("text", "font-size:16px;font-weight:700;line-height:1;color:#18191C"),
				),
				at(
					"time",
					{ row: 8, column: 2, span: 11 },
					`${HEAD};padding-top:2px;align-self:start`,
					undefined,
					part("text", "font-size:12px;color:#999"),
				),
				at(
					"title",
					full(9),
					"padding-top:10px",
					undefined,
					part(
						"text",
						"padding:0 16px;font-size:17px;font-weight:700;line-height:1.375;color:#18191C",
					),
				),
				at("divider", full(10), "padding-top:10px", "divider-1", DIVIDER_LINE),
				at("popularity", { row: 11, column: 1, span: 6 }, "padding-top:10px", undefined, DATA_TEXT),
				at(
					"area",
					{ row: 11, column: 7, span: 6 },
					"padding-top:10px;text-align:right",
					undefined,
					DATA_TEXT,
				),
				at("fans", full(12), "padding-top:4px", undefined, DATA_TEXT),
				at(
					"desc",
					full(13),
					"padding-top:16px",
					undefined,
					part("text", "padding:0 16px;font-size:13px;line-height:1.5;color:#999"),
				),
			],
		},
		dynamic: {
			width: 600,
			// 16 + 52(头像)+ 12(间距)
			columns: avatarColumns(80),
			css: `${FRAME_BG_USER}${GLASS_DYNAMIC}`,
			blocks: [
				at(
					"avatar",
					{ row: 1, column: 1, span: 1, rowSpan: 2 },
					`${HEAD};padding-left:16px;align-self:center`,
				),
				at("name", { row: 1, column: 2, span: 11 }, `${HEAD};align-self:end`),
				at("time", { row: 2, column: 2, span: 11 }, `${HEAD};padding-top:3px;align-self:start`),
				at("divider", full(3), "padding:12px 0", "divider-1", DIVIDER_LINE),
				at("topic", full(4), "padding:0 16px"),
				at("text", full(5), "padding:0 16px"),
				// ── 投稿视频那张卡:五块 + 一圈用 CSS 拼出来的灰底容器 ──────────────
				// 容器不是块(不造隐形底板),而是三段文字**各带一段灰底**、首尾分担圆角;
				// 封面上那 4px 是从前容器的 `mt-1`。568 宽的 16:9 封面约 320px 高 → 6 行。
				// 灰底也垫在封面下面 —— 从前那圈容器就是这么包的,封面预取失败时露出来的是这层灰
				// 而不是卡片背景。`overflow:hidden` 让圆角真的切到图上(圆角在 wrapper 上,
				// 图是它的孩子)。上面那 4px 是从前容器的 `mt-1`,用 margin 让灰底跟着让出来。
				at(
					"videoCover",
					tall(6, 6),
					`margin:4px 16px 0;${VIDEO_BG};${VIDEO_TOP_RADIUS};overflow:hidden`,
					"video-cover",
				),
				// 角标叠在封面右下角、层次更高(24px = 16px 内边距 + 8px)。格子收到它真正占的
				// 那一小块:封面跨 6–11 行,角标只摆在**最后那一行**(第 11 行的下沿就是封面的
				// 下沿,贴底的结果一模一样),列也只占第 12 列(本机量过:角标 519–561,
				// 第 12 列 505–585)。
				at(
					"videoDuration",
					{ row: 11, column: 12, span: 1, z: 1 },
					`${HEAD};align-self:end;justify-self:end;margin:0 24px 8px 0`,
					"video-duration",
				),
				at("videoTitle", full(12), `${VIDEO_INSET};padding:12px 12px 0`, "video-title"),
				at("videoDesc", full(13), `${VIDEO_INSET};padding:6px 12px 0`, "video-desc"),
				at(
					"videoStats",
					full(14),
					`${VIDEO_INSET};padding:10px 12px 12px;${VIDEO_BOTTOM_RADIUS}`,
					"video-stats",
				),
				// 图廊与视频互斥,**摆在同一片行**(决策 10 的 2026-09-18 🔗)。分开排行号的话
				// 出图一样,但画布上看「视频投稿」那一场时,图廊那七行就是七行标着「这一场
				// 不画」的死地,反过来也一样。
				//
				// ⚠️ 互斥**由数据自己表达**:没视频的卡,那五块取不到东西、整块不画;没图的卡
				// 图廊同理。从前另写过一层「形态覆盖」把对方藏起来,2026-09-19 现查过它在这份
				// 默认皮上零作用,已整层退役(决策 10 的 🔗)。画布那头靠块目录的 `scenes`
				// 知道两组各属哪一场,出图端不读它。
				// 图廊前那 8px 是旧正文里跟在文字后面的间距。九图图廊约 400px 高 → 7 行。
				at("pics", tall(6, 7), "padding:8px 16px 0"),
				at("forward", full(15), "padding:0 16px"),
				at("additional", full(16), "padding-top:12px"),
				at("divider", full(17), "padding:12px 0", "divider-2", DIVIDER_LINE),
				at("forwardCount", { row: 18, column: 1, span: 4 }, CENTER, "forward-count"),
				at("commentCount", { row: 18, column: 5, span: 4 }, CENTER, "comment-count"),
				at("likeCount", { row: 18, column: 9, span: 4 }, CENTER, "like-count"),
			],
		},
		sc: {
			width: 290,
			css: `${FRAME_BG_TIER}${GLASS_PLAIN}`,
			blocks: [
				// 金额是渐变裁字:用 text-align 居中,渐变才与旧的一样铺满整行。
				at("price", full(1), "text-align:center"),
				at("duration", full(2), CENTER),
				at("divider", full(3), "padding-top:15px", "divider-1", SC_LINE),
				at("avatar", full(4), `padding-top:12px;${CENTER}`),
				at("name", full(5), `padding-top:8px;${CENTER}`),
				at("to", full(6), `padding-top:8px;${CENTER}`),
				at("message", full(7), "padding-top:12px"),
			],
		},
		guard: {
			width: 430,
			columns: [
				...Array.from({ length: 8 }, () => ({ fr: 1 })),
				...Array.from({ length: 4 }, () => ({ px: 43.75 })),
			],
			// 两行胶囊 + 一行文字:前两行按内容高,最后一行吃掉剩下的卡高,文字贴底。
			css: `${FRAME_BG_TIER}[data-bn="glass"]{${glassBase(".75")};height:190px;grid-template-rows:auto auto 1fr}`,
			blocks: [
				at(
					"avatar",
					{ row: 1, column: 1, span: 4, rowSpan: 2 },
					"padding:12px 0 0 16px;align-self:start",
				),
				// 两颗胶囊贴着头像的中线上下排,各自收窄到内容宽(胶囊自带底色)。
				at("user", { row: 1, column: 5, span: 4 }, "align-self:end;justify-self:start"),
				at(
					"master",
					{ row: 2, column: 5, span: 4 },
					"padding-top:7px;align-self:start;justify-self:start",
				),
				at("text", { row: 3, column: 1, span: 8 }, "padding:0px 16px 12px;align-self:end"),
				at(
					"badge",
					{ row: 1, column: 9, span: 4, rowSpan: 3 },
					"height:190px;display:flex;align-items:center;align-self:start",
				),
			],
		},
		// 整张卡是一个固定内置块的三种:块模型进不去(词云是页面里跑画布脚本画的),
		// 皮肤只管它们外面那层外框。原来这三张长在旧默认皮肤上,由这里展开继承;
		// 旧默认已经删了(决策 17 / 24 的 2026-09-18 🔗),所以搬进来自己写。
		roastBoard: {
			width: 600,
			css: `${FRAME_BG_USER}${GLASS_ROAST}`,
			blocks: [at("body", full(1))],
		},
		roastSolo: { width: 430, css: `${FRAME_BG_USER}${GLASS_ROAST}`, blocks: [at("body", full(1))] },
		wordcloud: {
			width: 720,
			css: `${FRAME_BG_USER}${GLASS_WORDCLOUD}`,
			blocks: [at("body", full(1))],
		},
	},
};
