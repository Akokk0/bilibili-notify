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
