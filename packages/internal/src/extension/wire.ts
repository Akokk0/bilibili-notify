/**
 * 拓展交给面板去画的那一层(wire)的本体。
 *
 * 零依赖:只放常量与纯结构类型,值级 import 一条都没有。门转给拓展,
 * `apps/contract` 从这里 `import type` 转给面板。
 */

import type { EXTENSION_SOURCE_FEATURES } from "../features";
import type { CREATOR_SEARCH_INPUTS } from "../source";

// ---- 拓展声明式界面(ADR-0019)的零依赖判据 ----------------------------------------
//
// 清单的 schema(`schema/extension-manifest.ts`)与面板都直接从这里取值,两边拿的是同一份。

/** 列表项里保留给 BN 的键 —— 项的身份,由 BN 生成、藏起来、不许改(ADR-0019 决策 29)。 */
export const LIST_ITEM_ID_KEY = "id";

/**
 * 拓展交的图片(选项图标、表格的 icon 格)的上限 —— 整段 data URL 的字数。与桥协议里 bot 图标
 * 那条(`BRIDGE_BOT_ICON_MAX_BYTES`)同一个数:拓展包进不来 internal,只能各写一份。
 */
export const EXTENSION_IMAGE_MAX_CHARS = 32 * 1024;

/**
 * 拓展交的图片长什么样才收 —— **只收图片的 base64 data URL**,面板一律当 `<img>` 画(ADR-0019
 * 决策 31)。字数上限另算({@link EXTENSION_IMAGE_MAX_CHARS})。
 *
 * 不过 SVG 白名单:`<img>` 里的 SVG 不跑脚本、拉不进外部资源,而白名单每宽一格都是把外来标记
 * 塞进页面。不收 http(s) 地址:面板一开就去对家点名,不是图标该有的本事。
 *
 * ⚠️ 不带 `g`:几处共用这一个对象,带 `g` 的话 `test()` 会在两次调用之间记着 `lastIndex`。
 */
export const EXTENSION_IMAGE_DATA_URL_RE =
	/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;

/**
 * 一格**设置项 / 连接配置项** —— 面板照它画一栏,按**数据类型**分、不按控件分
 * (ADR-0019 决策 17)。v2 拓展把它写在清单里(`settings.fields` /
 * `contributes.push.connection.fields`),与代码里那份 zod 是两份声明,加载时对表。
 *
 * 🔴 **这是清单那份 schema 的手写镜像**:宿主把清单里读出来的格原样交给面板,所以
 * `ExtensionManifestField` 必须能赋给它 —— `manifest-shape-pin.ts` 的类型检查会替两份钉住。
 *
 * 🔴 `secret: true` 同时是**备份脱敏的依据**。脱敏本来靠一份键名黑名单,而拓展的键名归
 * 拓展自己起 —— 不声明的话,那个 token 会原样躺在主人发出去求助的备份文件里。
 */
export type ExtensionField = ExtensionScalarField | ExtensionListField;

/** 单值的那几种。推送源的连接配置项只能是它们(连接的 config 是扁平的一层键值)。 */
export type ExtensionScalarField =
	| (ExtensionFieldBase & {
			type: "string";
			default?: string;
			placeholder?: string;
			secret?: boolean;
			multiline?: boolean;
			monospace?: boolean;
			/** 面板替主人生成一串,新建时明文显示一次。 */
			generate?: boolean;
	  })
	| (ExtensionFieldBase & {
			type: "number";
			default?: number;
			min?: number;
			max?: number;
			step?: number;
			unit?: string;
	  })
	| (ExtensionFieldBase & { type: "boolean"; default?: boolean })
	| (ExtensionFieldBase & {
			type: "enum";
			/**
			 * 选项图标是图片的 base64 data URL(png / jpeg / webp / svg),面板当 `<img>` 画;
			 * 清单格式那一步已经把它限定成图片、封了顶。
			 */
			options: readonly { value: string; label: string; icon?: string }[];
			default?: string;
	  });

/**
 * 对象数组:每一项一张卡。只嵌一层 —— 项里只有单值。
 *
 * 项的 `id` 由 BN 生成、藏起来、不许改(视图按它把积木挂到那一项上),不在 `fields` 里。
 */
export interface ExtensionListField extends ExtensionFieldBase {
	type: "list";
	fields: readonly ExtensionScalarField[];
	/** 哪一格当卡片标题(项里一格必填的 string)。 */
	title: string;
	/** 一项叫什么(「接入」)。不给就用 `label`。 */
	itemLabel?: string;
	/** 哪个 enum 的选中项图标当卡片左上的方块。 */
	mark?: string;
	/** 哪一格 boolean 画成「停用 / 启用」。 */
	toggle?: string;
	/** 新建弹窗底部要成对复制的几样:BN 现算的地址,或者本项的某一格。 */
	newItemCopy?: readonly ({ host: "extensionUrl"; label: string } | { field: string })[];
	/** 删除确认里「删了会怎样」那句。 */
	removeWarning?: string;
}

interface ExtensionFieldBase {
	/** 值落在 `settings[key]` / `config[key]` —— **同时是这一栏的身份**。 */
	key: string;
	label: string;
	description?: string;
	required?: boolean;
}

/**
 * 一个拓展**推送源那一口**给面板的东西 —— 平台适配器的描述(ADR-0012 决策 33 / 46 那三格外观,
 * 加要主人填的那几栏):推送目标页照它画新建连接那一排的名字、连接卡上那张脸、以及连接配置项。
 *
 * **就这几格**:作用域、地址名词、能不能 @全体这些都是**bot 所在平台**的事(一条拓展连接
 * 就是一个借来的 bot,决策 45),从 bot 报的 `platform` 查注册表,不从这儿来。
 *
 * 写在清单里,拓展停着也有(ADR-0019 决策 41)。**有它不等于拓展在场** —— 要在场的看它的运行状态。
 */
export interface PlatformAdapterDescriptor {
	/** 全名:新建连接那一排、「经 xxx 借来的」那句。 */
	label: string;
	/** 短名:卡片上那个方章。 */
	shortLabel: string;
	/** 方章的底色,hex。 */
	color: string;
	/** 平台图标:图片 data URL(面板第 4 期按描述画时当 `<img>` 画,这一版还不读)。 */
	icon?: string;
	/** 要主人填的连接配置项;连接是挑出来的那种拓展就是空表。 */
	settingsFields: readonly ExtensionScalarField[];
}

/**
 * 一个拓展**订阅源那一口**给面板的东西:平台选择那一排的名字与脸、输入框的提示、配置弹层列
 * 哪几种特性。来自清单,**拓展停着也有**(ADR-0019 决策 41)—— 停用的拓展名下的订阅照样画得出
 * 是哪个平台的。**有它不等于拓展在场**:要它在场的(解析门)另看运行状态。
 *
 * 🔴 这是清单订阅段那份 zod 的**手写镜像**(去掉装包那头的 `cardSkin`),由
 * `manifest-shape-pin.ts` 的类型断言钉住。
 */
export interface ExtensionSubscriptionView {
	/** 全名:平台选择那一排的名字。 */
	label: string;
	/** 短名:徽章上那个方章。不给就用 `label`。 */
	shortLabel?: string;
	/** 方章的底色,hex。不给就退「认不出」那档灰。 */
	color?: string;
	/** 平台图标:图片 data URL(面板第 4 期按描述画时当 `<img>` 画,这一版还不读)。 */
	icon?: string;
	/** 这个平台管「一条动态」叫什么(抖音:作品)。不给就叫「动态」。 */
	postNoun?: string;
	/** 这个平台管创作者叫什么(抖音:博主)。不给就落中性叫法(`sourceNounsOf` 的中性词)。 */
	creatorNoun?: string;
	/** 这个平台管外部 id 叫什么(如「账号」)。身份标签用它,不给就写平台名。 */
	externalIdNoun?: string;
	/** 外部 id 长什么样:正则源码,宿主按整串匹配,核新建订阅的外部 id。不给就只做中立校验。编译不过的让清单读不了。 */
	externalIdRegex?: string;
	/**
	 * 搜人输入框收哪几种输入。提示句由核心按这份声明拼;第 4 期接上面板叫法函数前先不下发句子。
	 *
	 * 与 `CREATOR_SEARCH_INPUTS` 共用同一个联合类型,不再手写一份。
	 */
	searchAccepts?: readonly (typeof CREATOR_SEARCH_INPUTS)[number][];
	/**
	 * 这个源声明的特性(ADR-0019 决策 4 / 5),配置弹层只列这几种;顺序不保证,面板照 `FEATURE_KEYS` 排。
	 * `liveStreaming`(周期「正在直播」)是**同时有开播与下播**才有的(⑬d),这个推法由服务端算一次。
	 *
	 * 与 `EXTENSION_SOURCE_FEATURES` 共用同一个联合类型,不再手写一份。
	 */
	supportedFeatures: readonly (typeof EXTENSION_SOURCE_FEATURES)[number][];
}

/**
 * 拓展交给面板的「视图」—— v2 的 `ctx.publishView` 交的就是它(ADR-0019 决策 20 / 26–28,09-23
 * 决策 39 改过一轮)。
 *
 * 一组**封闭的积木**,由 BN 照着画;派生的东西由拓展算好交来,BN 不发明表达式语言。
 *
 * 🔴 这是同一包里 `ExtensionViewSchema` 的**手写镜像**,两份由 `view-shape-pin.ts`
 * **双向严格相等**地钉住 —— 这里多一个可选键,那边就过不了类型检查。
 *
 * 不合规矩时宿主**按块 / 按项**降级(决策 40):页上坏一块只换掉那一块,列表坏一项那张卡写「状态
 * 未知」,摘要坏了就不画。那些「坏了」的标记只有宿主加得了,不在这个类型里。
 */
export interface ExtensionView {
	/** 拓展列表页那一行。 */
	summary?: ExtensionViewSummary;
	/** 挂在头卡正文里的积木。 */
	page?: readonly ExtensionBlock[];
	/**
	 * 列表设置项的 key → 项的 id → 那一项在卡上的样子。第一层的键必须是清单里声明过的**列表**
	 * 设置项、第二层是那张列表里现存的项 —— 对不上的宿主丢掉并记一行日志。
	 */
	items?: Readonly<Record<string, Readonly<Record<string, ExtensionItemView>>>>;
	/**
	 * 图片字典:键 → 图片的 base64 data URL(png / jpeg / webp / svg,单张封顶,与选项图标同一条)。
	 * 表格的图标格、二维码按键引用 —— 同一张图只放一份。整份视图序列化后有字节上限(256 KiB)。
	 */
	images?: Readonly<Record<string, string>>;
}

/** 拓展列表页那一行。 */
export interface ExtensionViewSummary {
	tone?: ExtensionTone;
	text: ExtensionViewText;
}

/** 状态的语气,同时决定卡角那团颜色。 */
export type ExtensionTone = "ok" | "warn" | "error" | "off";

/**
 * 一段字:一个字符串,或者一串片段。片段只有五种 —— 字、加粗、等宽、一个时刻(浏览器按
 * 「N 分钟前」画,`suffix` 接在后面)、BN 在浏览器里现算的地址。
 */
export type ExtensionViewText = string | readonly ExtensionViewTextSegment[];
export type ExtensionViewTextSegment =
	| string
	| { b: string }
	| { mono: string }
	| { time: number; suffix?: string }
	| { host: "extensionUrl" };

/**
 * 一颗按钮,显式带 `kind`:
 * - `action`:调拓展(清单 `actions` 里声明、代码 `ctx.onAction` 接)—— 名字不在清单里的,宿主把那一块 /
 *   那一项按降级画;
 * - `set`:让 BN 改**这一项**的一格设置 —— 只许挂在列表项上,只许改那张列表声明过的格,不碰
 *   `id`、密钥与生成的格,值的类型要对得上(`enum` 要在选项里)。
 */
export type ExtensionButton =
	| { kind: "action"; label: string; action: string }
	| { kind: "set"; label: string; set: Readonly<Record<string, string | number | boolean>> };

/** 列表的一项在卡上的那几格。停用的项由 BN 盖成「已停用」,`status` 报什么都不算。 */
export interface ExtensionItemView {
	status?: { tone: ExtensionTone; text: string };
	pill?: string;
	subtitle?: ExtensionViewText;
	buttons?: readonly ExtensionButton[];
	/** 画在 BN 画的字段行(token 行这种)上面的积木。 */
	lead?: readonly ExtensionBlock[];
	/** 画在字段行下面的积木。 */
	blocks?: readonly ExtensionBlock[];
}

export type ExtensionTableColumn =
	| { kind: "icon" }
	| { kind: "text"; width?: number }
	| { kind: "mono" }
	| { kind: "tristate"; label: string };

/**
 * 表格的一格 —— **自带种类**,与列的 `kind` 同一套词;宿主核「这一格与这一列同种」。图标格的
 * `image` 是 {@link ExtensionView.images} 里的键,没有就印 `fallback` 那两个字。
 */
export type ExtensionTableCell =
	| { kind: "icon"; image?: string; fallback: string }
	| { kind: "text"; text: string; sub?: string }
	| { kind: "mono"; text: string }
	| { kind: "tristate"; value: "yes" | "no" | "unknown" };

export type ExtensionBlock =
	| {
			type: "keyValue";
			items: readonly { label: string; value: ExtensionViewText; tone?: ExtensionTone }[];
	  }
	| {
			type: "table";
			title?: string;
			count?: boolean;
			empty?: ExtensionViewText;
			columns: readonly ExtensionTableColumn[];
			rows: readonly (readonly ExtensionTableCell[])[];
	  }
	| {
			type: "notice";
			tone: "info" | "warn" | "error";
			text: ExtensionViewText;
			button?: ExtensionButton;
	  }
	| {
			type: "copy";
			label: string;
			value: string | { host: "extensionUrl" };
			note?: ExtensionViewText;
	  }
	/** `image` 是 {@link ExtensionView.images} 里的键。 */
	| { type: "qr"; image: string; caption?: ExtensionViewText }
	| { type: "button"; button: ExtensionButton };
