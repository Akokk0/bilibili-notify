/**
 * 皮肤包 wire 契约 —— `skin.json` 的形状(schemaVersion 1)与语义字段清单。
 *
 * 皮肤只写**语义化字段**(colors.accent / wallpaper.image / …),不暴露内部
 * `--bn-*` 令牌名:内部令牌改名/拆分不破坏存量皮肤,能力清单永远由这里定义。
 * 语义字段 → CSS 变量的映射表也在本文件(纯常量,web 合成层消费);
 * 校验逻辑(zod)按包纪律留在 apps/server/src/skins/schema.ts。
 */

export const SKIN_SCHEMA_VERSION = 1;

/**
 * 颜色语义键 → 内部 CSS 变量。键名是对外承诺的公开 API,只增不改;
 * 右侧变量名是实现细节,重构时改这张表即可。
 */
export const SKIN_COLOR_TOKEN_MAP = {
	accent: "--color-bn-pink",
	accentSoft: "--color-bn-pink-soft",
	accentAlt: "--color-bn-blue",
	accentAltSoft: "--color-bn-blue-soft",
	accentAltBright: "--color-bn-blue-light",
	highlight: "--color-bn-purple",
	textPrimary: "--color-bn-text-primary",
	textSecondary: "--color-bn-text-secondary",
	textTertiary: "--color-bn-text-tertiary",
	textDisabled: "--color-bn-text-disabled",
	surface: "--color-bn-surface",
	surfaceStrong: "--color-bn-surface-strong",
	surfaceMuted: "--color-bn-surface-muted",
	field: "--color-bn-field",
	border: "--color-bn-border",
	borderSubtle: "--color-bn-border-subtle",
	hoverMuted: "--color-bn-hover-muted",
	codeBg: "--color-bn-code-bg",
	overlay: "--color-bn-overlay",
	danger: "--color-bn-danger",
	dangerSoft: "--color-bn-danger-soft",
	dangerText: "--color-bn-danger-text",
	dangerBorder: "--color-bn-danger-border",
	success: "--color-bn-success",
	successSoft: "--color-bn-success-soft",
	successText: "--color-bn-success-text",
	successBorder: "--color-bn-success-border",
	warning: "--color-bn-warning",
	warningSoft: "--color-bn-warning-soft",
	warningText: "--color-bn-warning-text",
	warningBorder: "--color-bn-warning-border",
} as const;

export type SkinColorKey = keyof typeof SKIN_COLOR_TOKEN_MAP;

export type SkinWallpaperFit = "cover" | "contain" | "tile";

/** 主题文案槽位白名单;加新槽位只增不改。 */
export const SKIN_TEXT_SLOTS = ["headerTitle", "chatPlaceholder"] as const;
export type SkinTextSlot = (typeof SKIN_TEXT_SLOTS)[number];

/**
 * 皮肤 CSS 的语义挂点(hook)→ 真实选择器映射。与 SKIN_COLOR_TOKEN_MAP 同哲学:
 * 左侧 hook 名是对外承诺的公开 API(只增不改,皮肤 CSS 里写 `[data-bn="<hook>"]`),
 * 右侧真实选择器是实现细节 —— 清洗层(server)只验 hook 合法性并按 hook 形式存盘,
 * **翻译发生在注入时**(web 合成层),所以内部重构改这张表即可,存量皮肤跟着走。
 *
 * `~=` 匹配:一个元素可以同时挂多个 hook(`data-bn="btn btn-primary"`)。
 */
export const SKIN_CSS_HOOK_MAP = {
	/** 整页(壁纸层之上、所有内容之下的根;粒子/氛围层挂它的伪元素)。 */
	page: "body",
	/** 所有轻玻璃卡片。 */
	glass: ".bn-glass",
	/** 强玻璃面(弹窗、浮条、抽屉)。 */
	"glass-strong": ".bn-glass-strong",
	/** 所有按钮。 */
	btn: '[data-bn~="btn"]',
	/** 主(粉色实底)按钮。 */
	"btn-primary": '[data-bn~="btn-primary"]',
	/** 单行输入框。 */
	input: '[data-bn~="input"]',
	/** 顶栏。 */
	header: '[data-bn~="header"]',
	/** 页面级导航条(tab 条 / 分区导航)。 */
	nav: '[data-bn~="nav"]',
	/** 圆头像。 */
	avatar: '[data-bn~="avatar"]',
	/** 弹窗卡片本体。 */
	modal: '[data-bn~="modal"]',
} as const;

export type SkinCssHook = keyof typeof SKIN_CSS_HOOK_MAP;

export const SKIN_DECORATION_ANCHORS = [
	"top-left",
	"top",
	"top-right",
	"left",
	"center",
	"right",
	"bottom-left",
	"bottom",
	"bottom-right",
] as const;
export type SkinDecorationAnchor = (typeof SKIN_DECORATION_ANCHORS)[number];

/** 贴纸/立绘装饰件:钉在视口九宫格锚点上,渲染层 pointer-events 穿透。 */
export interface SkinDecoration {
	image: string;
	anchor: SkinDecorationAnchor;
	/** 渲染宽度 px(高度按图片比例)。 */
	width: number;
	opacity: number;
	offsetX?: number;
	offsetY?: number;
}

/** 一套模式(light 或 dark)下的皮肤定义,所有字段可选 —— 没给的回默认装。 */
export interface SkinMode {
	colors?: Partial<Record<SkinColorKey, string>>;
	/** 整页背景(颜色或渐变);wallpaper.image 存在时被壁纸合成覆盖。 */
	page?: { background?: string };
	wallpaper?: {
		/** 只允许引用包内资源:`assets/<文件名>`。 */
		image?: string;
		fit?: SkinWallpaperFit;
		/** CSS background-position 语法的受限子集(关键词/百分比)。 */
		position?: string;
		/** 压暗遮罩不透明度 0~0.8,保文字可读性。 */
		overlay?: number;
	};
	glass?: {
		background?: string;
		border?: string;
		strongBackground?: string;
		strongBorder?: string;
		/** backdrop blur,单位 px,0~40。 */
		blur?: number;
		strongBlur?: number;
	};
	fonts?: {
		/** 正文字体栈,按序拼接;字体名做字符白名单校验。 */
		body?: string[];
	};
	radius?: {
		/** 卡片圆角 px,0~32。 */
		card?: number;
		/** 胶囊圆角 px,0~999。 */
		pill?: number;
	};
	/** 贴纸装饰层,最多 6 件。 */
	decorations?: SkinDecoration[];
	/** 卡片/悬浮两档阴影 —— 有色 glow 即霓虹感。 */
	shadows?: { card?: string; elev?: string };
	/** Dashboard 首页顶部 hero 横幅;皮肤给了才渲染。 */
	banner?: {
		image: string;
		/** 渲染高度 px,80~400。 */
		height: number;
		fit?: "cover" | "contain";
		position?: string;
	};
	/**
	 * 本模式追加的自定义 CSS(叠在顶层 css 之后)。选择器只准引用
	 * SKIN_CSS_HOOK_MAP 的 hook,属性走视觉白名单 —— 服务端清洗后按 hook
	 * 形式存盘,注入时才翻译成真实选择器。单段 ≤64KB。
	 */
	css?: string;
}

export interface SkinManifest {
	schemaVersion: typeof SKIN_SCHEMA_VERSION;
	name: string;
	author?: string;
	description?: string;
	/** 至少给一套;只给一套时前端应用后锁定该模式。 */
	modes: { light?: SkinMode; dark?: SkinMode };
	/** 主题文案槽(跨明暗共用),槽位白名单见 SKIN_TEXT_SLOTS。 */
	texts?: Partial<Record<SkinTextSlot, string>>;
	/** 明暗共用的自定义 CSS;语法与约束同 SkinMode.css,mode 级的追加在它之后。 */
	css?: string;
}

// ---- wire 形状(皮肤库 API) ----------------------------------------------

export interface SkinListEntry {
	id: string;
	name: string;
	author?: string;
	description?: string;
	/** 提供了哪几套模式;单套皮肤应用后前端锁定该模式。 */
	modes: Array<"light" | "dark">;
	hasWallpaper: boolean;
}

/** GET /api/skins */
export interface SkinsListResponse {
	list: SkinListEntry[];
	activeId: string | null;
}

/** GET /api/skins/active(未启用皮肤时 wire 上是 { active: null })。 */
export interface ActiveSkinResponse {
	active: { id: string; manifest: SkinManifest } | null;
}

/** GET /api/skins/:id/manifest —— assets 是包内资产清单(`assets/<名>`),编辑器图片字段的可选项。 */
export interface SkinManifestResponse {
	manifest: SkinManifest;
	assets: string[];
}

/** PUT /api/skins/:id/manifest(编辑器就地保存,资产不变)。 */
export type SkinManifestUpdateResponse =
	| { ok: true; warnings: string[] }
	| { ok: false; errors: string[] };
