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
	accentAlt: "--color-bn-blue",
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
	/** 玻璃卡内数据列表行的底色/描边(默认:70% surface / 透明)——治「玻璃叠玻璃」的口子。 */
	listRow: "--color-bn-list-row",
	listRowBorder: "--color-bn-list-row-border",
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

/**
 * 皮肤各数值字段的取值域,**唯一事实源**。
 *
 * 服务端校验、编辑器滑杆、两份 AI 提示词读的都是这张表。分散着写的时候,放宽
 * 任何一档都要同时改五处 —— 漏掉编辑器,滑杆拉不到合法值;漏掉提示词,AI 会
 * 稳定产出被校验拒收的皮肤,而那是一趟两分半的调用。
 */
export const SKIN_LIMITS = {
	/** 壁纸遮罩纱的不透明度。 */
	wallpaperOverlay: { min: 0, max: 0.8 },
	/** 壁纸自身的高斯模糊(px)。 */
	wallpaperBlur: { min: 0, max: 40 },
	/** 玻璃模糊(px);blur 与 strongBlur 同域。 */
	glassBlur: { min: 0, max: 40 },
	/** 卡片圆角(px)。 */
	radiusCard: { min: 0, max: 32 },
	/** 胶囊圆角(px);999 就是两端画圆。 */
	radiusPill: { min: 0, max: 999 },
	/** 字体栈最多收几个名字,超出截断(不拒包)。 */
	maxFonts: 8,
	/** 光斑最多几色。 */
	maxBokehColors: 4,
	/** 文案槽位每条最多几个字。 */
	maxTextChars: 60,
	/** 自定义 CSS 上限,**按 UTF-8 字节算**(不是 UTF-16 单元数)。 */
	maxCssBytes: 64 * 1024,
} as const;

export type SkinWallpaperFit = "cover" | "contain" | "tile";

/**
 * 皮肤自带字体在 CSS 里的家族名。
 *
 * 固定一个内部名字,而不是去解析字体文件里的真名:解析 ttf/otf 要拖一个字体解析库
 * 进浏览器,而这里唯一需要的就是「@font-face 声明的名字」和 `--font-cjk` 引用的名字
 * 对得上。与卡片出图那边的 `USER_FONT_FAMILY`(bn-user-font)刻意不同名 —— 两条路
 * 的字体来源不同,撞名的话谁先声明谁说了算,而那正是最难查的一类。
 */
export const SKIN_FONT_FAMILY = "bn-skin-font";

/**
 * 字体后缀 → CSS `@font-face` 的 `format()` 提示。
 *
 * 写上它浏览器才能在**下载之前**判断认不认这份字体 —— 一款完整中文字库有八九兆,
 * 拉完才发现格式不支持是实打实的浪费。注意 ttf / otf 的 format 名与后缀**不同名**
 * (`truetype` / `opentype`),照抄后缀等于没写。
 *
 * 住在契约里是因为服务端(收什么后缀)与 web(拼 @font-face)得认同一份清单。
 */
export const SKIN_FONT_FORMATS: Record<string, string> = {
	woff2: "woff2",
	woff: "woff",
	ttf: "truetype",
	otf: "opentype",
};

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
	/**
	 * 所有轻玻璃卡片。类与属性两条路都收 —— `.bn-glass` 是「长成玻璃」,
	 * `[data-bn~="glass"]` 是「按玻璃换装但保持自己的观感」。
	 *
	 * 为什么要第二条路:其余 7 个挂点都是属性挂点,挂上零视觉变化;这两档原来只认
	 * 类名,而加类会连带一整套底色/模糊/描边。于是实底浮层(toast、告警、各种下拉)
	 * **没有零代价的挂法** —— 要么改观感,要么够不到。属性挂点补上这条路。
	 *
	 * **必须写成 `:is()`,不能写成逗号列表。** 注入时的翻译(`translateSkinCssHooks`)
	 * 是纯字符串替换:皮肤写 `[data-bn="glass"]:hover`,逗号列表会翻成
	 * `.bn-glass,[data-bn~="glass"]:hover` —— 伪类只贴到最后一支,静默改掉语义且
	 * 不会红。`:is()` 的特异性取参数最大值(0-1-0),与原来的 `.bn-glass` 一致,
	 * 层叠关系不变。
	 */
	glass: ':is(.bn-glass,[data-bn~="glass"])',
	/** 强玻璃面(弹窗、浮条、抽屉)。两条路同上。 */
	"glass-strong": ':is(.bn-glass-strong,[data-bn~="glass-strong"])',
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

/**
 * 每个 CSS 挂点在这个面板里**长什么样**。
 *
 * 光把名字列出来,AI 只能按名字想象形状,而想错了没有任何东西会拦它:真机上
 * `nav` 被当成横向胶囊条写了 `border-radius:999px`,落到竖向的分区列表上就成了
 * 一个盖住半个页面的大椭圆(2026-08-18)。挂点是对外承诺的公开 API,加一个就得
 * 在这儿补一句 —— ai-create 的测试遍历 {@link SKIN_CSS_HOOK_MAP} 钉着这条。
 *
 * 放在契约里是因为**两条造皮肤的路都要教这件事**:聊天里的内置设计师,和粘给
 * 外部 AI 的那份提示词。只教一边的话,另一边会把同一个坑再踩一次。
 */
export const SKIN_CSS_HOOK_NOTES: Record<SkinCssHook, string> = {
	page: '"page"=整页根(壁纸之上、内容之下;氛围层挂它的伪元素)',
	glass: '"glass"=所有轻玻璃卡片(小到一行数据卡,大到整块面板)',
	"glass-strong": '"glass-strong"=强玻璃面(弹层、浮条、抽屉)',
	btn: '"btn"=所有按钮(矮元素,胶囊圆角安全)',
	"btn-primary": '"btn-primary"=主按钮(粉色实底那种)',
	input: '"input"=单行输入框',
	header: '"header"=顶栏(横向长条)',
	nav: '"nav"=页面级导航容器 —— 横向 tab 条和**竖向的分区列表**都挂它,别当成横条设形状',
	avatar: '"avatar"=圆头像(本身已经是圆的)',
	modal: '"modal"=弹窗卡片本体',
};

/**
 * 官方皮肤库的统一手感,原样拼进两份 AI 提示词。
 *
 * 这几条是**与受众无关的硬事实**(哪些字段该配什么值),不是语气 —— 而它此前在
 * 服务端与 web 各存一份措辞不同的副本。git 记录里 77201cc / acdf5a5 / 2af2191
 * 每次都同时改两边,已经付过三次双份账;真正的代价是漏改一边之后,两条造皮肤的
 * 路会教出两套不同规格的 AI,而构建全绿,只有真机上看得出来。
 */
export const SKIN_BEST_PRACTICES = `- **亮色皮肤**:glass 统一 { background: "rgba(255, 255, 255, 0.85)", strongBackground: "rgba(255, 255, 255, 0.88)", blur: 12 },不配描边;**不写 shadows**(默认装的双层影就是亮色标准);**不写 effects**(流光/光斑这类特效全属暗色 —— 亮底上流光吃层次、光斑发灰),亮色的表现力靠渐变结界底 + 配色 + CSS
- **暗色皮肤**:glass 统一透明度 —— background 取皮肤深底色相 alpha 0.55、strongBackground 取更深一档 alpha 0.85,blur: 18、strongBlur: 26;描边配霓虹细边(border alpha 0.22~0.28 / strongBorder 0.3~0.35);shadows 统一双层结构:card "0 10px 36px rgba(<深底>, 0.65), 0 0 18px rgba(<主强调>, 0.12)"、elev "0 18px 56px rgba(<深底>, 0.75), 0 0 30px rgba(<主强调>, 0.2)";**开 glassShine**(color 取主强调 alpha 0.32)+ bokeh(2~3 团霓虹色,alpha 0.4~0.75)—— 动效特效是暗色的专属语汇
- **texts 写沉浸式世界观文案**:chatPlaceholder 用「状态确认 + 引导输入」句式(如「神经链路已接入,输入指令开始同步…」「39 频道已连线,和 Miku 酱开始今天的演出吧♪」),别写说明书腔`;

/**
 * CSS 属性白名单在两份提示词里的说法 —— 与 {@link SKIN_BEST_PRACTICES} 同一个理由:
 * 服务端的 ai-edit 与 web 的 skin-pack 此前各存一份,措辞已经漂开(一份列了
 * outline/text-shadow,另一份没有)。漏改一边不会红,只会让两条造皮肤的路教出
 * 两套规格的 AI —— 白名单加一个属性时尤其明显,那正是这次收口的由头。
 */
export const SKIN_CSS_PROP_NOTES = `- 属性走视觉白名单:background/border/outline/box-shadow/text-shadow/color/opacity/filter/backdrop-filter/mix-blend-mode/transform/transition/animation/border-radius/clip-path/image-rendering/inset/width/height/z-index 等;**display、pointer-events、visibility 会被丢弃**
- 做**像素风**就在 page 挂点写 image-rendering:pixelated —— 白名单里唯一继承的属性,写一处整站关掉平滑插值,壁纸与头像才有硬点阵边`;

/**
 * 动效预设(每套 mode 独立;全部自动尊重 prefers-reduced-motion)。
 * 有对象即开启;字段缺省走各自默认。
 * 注:曾有 backgroundFlow(页面背景流动,整页重绘卡顿)与 particles(粒子飘落,
 * 主人真机验收后砍掉),均已移除 —— 存量字段走未知字段告警 + 忽略降级。
 */
export interface SkinEffects {
	/** 玻璃卡辉光呼吸/游走(box-shadow 动画,不动布局)。color 默认主强调色。 */
	glassShine?: { color?: string };
	/** 悬浮大光斑(bokeh),1~4 团颜色。 */
	bokeh?: { colors: string[] };
}

/** 壁纸定义 —— 整页 wallpaper 与 chat.wallpaper 同构共用。 */
export interface SkinWallpaper {
	/** 只允许引用包内资源:`assets/<文件名>`。 */
	image?: string;
	fit?: SkinWallpaperFit;
	/** CSS background-position 语法的受限子集(关键词/百分比)。 */
	position?: string;
	/** 遮罩纱不透明度 0~0.8,保文字可读性;纱色跟模式走(亮=白纱,暗=黑纱)。 */
	overlay?: number;
	/** 壁纸自身高斯模糊 0~40px(静态一次成像):高饱和壁纸退成柔和色底。 */
	blur?: number;
}

/** 一套模式(light 或 dark)下的皮肤定义,所有字段可选 —— 没给的回默认装。 */
export interface SkinMode {
	colors?: Partial<Record<SkinColorKey, string>>;
	/** 整页背景(颜色或渐变);wallpaper.image 存在时被壁纸合成覆盖。 */
	page?: { background?: string };
	wallpaper?: SkinWallpaper;
	/**
	 * AI 聊天页专属外观。皮肤生效时 chat 观感整体由皮肤接管(四色预设隐藏):
	 * 强调色从 colors.accent 派生、玻璃件直接用 glass 段参数 —— chat 段**只管
	 * 背景**(底色/壁纸),不另设一套颜色或玻璃参数。
	 */
	chat?: {
		/** chat 整页底(纯色或渐变);缺省引用皮肤整页背景。 */
		background?: string;
		/** chat 专属壁纸(独立于整页壁纸),字段同构。 */
		wallpaper?: SkinWallpaper;
	};
	/** 默认装玻璃卡无描边(卡片风,层次靠阴影);border 对是皮肤刻意要描边风格的口子。 */
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
		/**
		 * 主人上传的字体文件,只允许引用包内资源:`assets/<文件名>.woff2|woff|ttf|otf`。
		 *
		 * **设了就排在 {@link body} 前面**,而不是顶掉它 —— 字体文件加载失败(网断、
		 * 文件被删)时还有字体栈接着兜,不至于一路掉到系统兜底链。
		 *
		 * 与壁纸同构:字段里只存包内名字,拼成 `@font-face` 的 url 是注入层的事。
		 * 皮肤自定义 CSS 的白名单**直接拒收 `url()`**,所以这是自带字体唯一的入口。
		 */
		asset?: string;
	};
	radius?: {
		/** 卡片圆角 px,0~32。 */
		card?: number;
		/** 胶囊圆角 px,0~999。 */
		pill?: number;
	};
	/** 卡片/悬浮两档阴影 —— 有色 glow 即霓虹感。 */
	shadows?: { card?: string; elev?: string };
	/**
	 * 本模式追加的自定义 CSS(叠在顶层 css 之后)。选择器只准引用
	 * SKIN_CSS_HOOK_MAP 的 hook,属性走视觉白名单 —— 服务端清洗后按 hook
	 * 形式存盘,注入时才翻译成真实选择器。单段 ≤64KB。
	 */
	css?: string;
	/** 动效预设(粒子/玻璃流光/光斑),见 SkinEffects。 */
	effects?: SkinEffects;
}

export interface SkinManifest {
	schemaVersion: typeof SKIN_SCHEMA_VERSION;
	name: string;
	author?: string;
	description?: string;
	/** 至少给一套;深浅色槽各自换装,单套皮肤只装扮它有的那个模式(锁模式只发生在试穿)。 */
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
	/** 提供了哪几套模式;决定能占哪个启用槽(试穿单套皮肤时前端锁到该模式看效果)。 */
	modes: Array<"light" | "dark">;
	hasWallpaper: boolean;
}

/** 深浅色各一个启用槽:浅色模式渲染 light 槽,暗色渲染 dark 槽;槽空 = 默认装。 */
export interface SkinActiveIds {
	light: string | null;
	dark: string | null;
}

/** GET /api/skins */
export interface SkinsListResponse {
	list: SkinListEntry[];
	active: SkinActiveIds;
}

/** GET /api/skins/active —— 双槽,槽里带完整 manifest,空槽为 null。 */
export interface ActiveSkinResponse {
	active: {
		light: { id: string; manifest: SkinManifest } | null;
		dark: { id: string; manifest: SkinManifest } | null;
	};
}

/** GET /api/skins/:id/manifest —— assets 是包内资产清单(`assets/<名>`),编辑器图片字段的可选项。 */
export interface SkinManifestResponse {
	manifest: SkinManifest;
	assets: string[];
	/**
	 * `assets/<生成名>` → 主人上传时那个文件叫什么。**只做显示** —— 盘上、URL 里、
	 * CSS 的 `url()` 里用的永远是生成名,原名唯一的去处是界面上的一段文本。
	 *
	 * 清单里没有的资产回落成生成名,所以这张表可以是空的、也可以只覆盖一部分。
	 */
	assetNames: Record<string, string>;
}

/** PUT /api/skins/:id/manifest(编辑器就地保存,资产不变)。 */
export type SkinManifestUpdateResponse =
	| { ok: true; warnings: string[] }
	| { ok: false; errors: string[] };

/**
 * GET /api/skins/:id/default —— 出厂快照(「恢复默认值」的基准)。
 * 上传时快照自动 = 上传内容;PUT 同路径把当前 manifest 钉成新基准(「设为默认值」)。
 */
export interface SkinDefaultResponse {
	manifest: SkinManifest;
}

/** POST /api/skins/:id/ai-edit(「让女仆改」)。产物只回编辑器 draft,不落盘。 */
export type SkinAiEditResponse =
	| { ok: true; manifest: SkinManifest; warnings: string[] }
	| { ok: false; errors: string[] };
