/**
 * `@bilibili-notify/extension/wire` —— 契约里**过 wire 的那几格**,一个**零依赖**子入口。
 *
 * 拓展照旧从根入口拿它们(那里转出来了),分一个子入口出来只为一件事:
 * `@bilibili-notify/contract` 的规矩是「运行时只许依赖零依赖的子入口」(见它的文件头),
 * 而根入口驮着 zod 与 `@bilibili-notify/internal` 的整个域模型 —— 面板那一侧要的其实只是
 * 这几个形状。
 *
 * ⛔ **只放纯结构类型**:不 import zod、不 import internal、一行运行时值都没有。往这儿加
 * 一格之前先问它是不是这种东西 —— 不是的话它属于根入口。
 */

/**
 * 一格**设置项 / 连接配置项** —— 面板照它画一栏,按**数据类型**分、不按控件分
 * (ADR-0019 决策 17)。v2 拓展把它写在清单里(`settings.fields` /
 * `contributes.push.connection.fields`),与代码里那份 zod 是两份声明,加载时对表。
 *
 * 🔴 **这是清单那份 schema 的手写镜像**(这个入口不许 import zod 与 internal,见文件头):
 * 宿主把清单里读出来的格原样交给面板,所以 `@bilibili-notify/internal` 的
 * `ExtensionManifestField` 必须能赋给它 —— 宿主那头的类型检查会替两份钉住。
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
 * 一个口在界面上的样子(ADR-0012 决策 46 那三格)。v2 写在清单的 `contributes.<口>.display`,
 * v1 由代码交(老名字 {@link ExtensionDescriptor},宿主收下时翻译过来)。
 *
 * **就这三格**:作用域、地址名词、能不能 @全体这些都是**bot 所在平台**的事(一条拓展连接
 * 就是一个借来的 bot,决策 45),从 bot 报的 `platform` 查注册表,不从这儿来。
 */
export interface ExtensionDisplay {
	/** 全名:新建连接那一排、「经 xxx 借来的」那句。 */
	label: string;
	/** 短名:卡片上那个方章。 */
	shortLabel: string;
	/** 方章的底色,hex。 */
	color: string;
}

/**
 * **v1 的老形状** —— 外观与连接配置项写在代码里、`registerPushSource` 时交。只剩桥还在用,
 * 宿主收下那一刻翻译成 {@link ExtensionField} / {@link ExtensionDisplay}(宿主里只有新形状);
 * 桥迁到 v2、再抬最低档之后整段删掉。
 */
export type ExtensionConfigField = ExtensionConfigFieldBase &
	(
		| {
				kind: "text";
				placeholder?: string;
				mono?: boolean;
				secret?: boolean;
		  }
		| { kind: "number"; min?: number; max?: number; step?: number; suffix?: string }
		| { kind: "toggle" }
		| { kind: "select"; options: readonly { value: string; label: string }[] }
	);

interface ExtensionConfigFieldBase {
	/** config 里的键名。**同时是这一栏的身份** —— 值就落在 `config[code]`。 */
	code: string;
	label: string;
	hint?: string;
	required?: boolean;
}

/**
 * 一个拓展**推送源那一口**给面板的东西:推送目标页照它画新建连接那一排的名字、连接卡上
 * 那张脸、以及要主人填的那几栏(ADR-0012 决策 33 / 46)。
 *
 * 两样一起交、一起有,缺一样面板就画不全。v2 写在清单里,拓展停着也有(ADR-0019 决策 41);v1 写在
 * 代码里,只有注册了推送源的(也就是跑着的)才有。**有它不等于拓展在场** —— 要在场的看它的运行状态。
 */
export interface ExtensionPushView {
	display: ExtensionDisplay;
	connectionFields: readonly ExtensionScalarField[];
}

/**
 * 订阅源那一口在界面上的样子 —— 清单 `contributes.subscription.display`。比推送源那三格多两格
 * 可选的叫法。
 *
 * 🔴 这是清单那份 zod 的**手写镜像**,两份由宿主那头的类型断言双向严格相等地钉住
 * (`apps/server/src/extensions/subscription-shape-pin.ts`)。
 */
export interface ExtensionSubscriptionDisplay extends ExtensionDisplay {
	/** 这个平台管「一条动态」叫什么(抖音:作品)。不给就叫「动态」。 */
	postNoun?: string;
	/** 新建订阅时输入框里那句提示(抖音:粘主页链接)。不给就用通用说法(ADR-0019 决策 51)。 */
	lookupPlaceholder?: string;
}

/**
 * 订阅源会报的事件种类(ADR-0019 决策 4)—— 中立名,BN 入口处映射到自己的特性。配置弹层只列
 * 这个源报的那几种。镜像 `@bilibili-notify/internal` 的 `SubscriptionEventKind`,同上钉住。
 */
export type ExtensionSubscriptionEventKind = "post" | "liveStart" | "liveEnd";

/**
 * 一个拓展**订阅源那一口**给面板的东西:平台选择那一排的名字与脸、输入框的提示、配置弹层列
 * 哪几种事件。来自清单,**拓展停着也有**(ADR-0019 决策 41)—— 停用的拓展名下的订阅照样画得出
 * 是哪个平台的。**有它不等于拓展在场**:要它在场的(解析门)另看运行状态。
 */
export interface ExtensionSubscriptionView {
	display: ExtensionSubscriptionDisplay;
	events: readonly ExtensionSubscriptionEventKind[];
}

/**
 * 解析门交回的一个候选(ADR-0019 决策 11 / 52):主人粘的东西解析出来「可能是这个人」。建不建、
 * 建成什么样由 BN 定,拓展只给候选。
 *
 * 🔴 宿主先核形状再交给面板,不合规矩的整次回「形状不对」并说清哪儿不对(最多 20 条、名字 1–128
 * 字、`id` 非空且有长度上限、粉丝数是非负整数、头像见下)。严格:多一个键也算不合。
 */
export interface ExtensionSubscriptionCandidate {
	/** 这个人在那个平台上的 id(抖音的 `sec_uid`)。BN 不解读,原样存、原样交回给拓展。 */
	id: string;
	name: string;
	/**
	 * 头像:**位图**的 base64 data URL(png / jpeg / webp),有大小上限。**不收 SVG** —— 建成订阅
	 * 之后它存成文件、从同源地址取,同源的 SVG 被直接打开时会跑脚本(ADR-0019 决策 49)。不交 URL:
	 * 平台的图链带签名、会过期、要 Referer。
	 */
	avatar?: string;
	fans?: number;
}

/** **v1 的老形状**,新名字是 {@link ExtensionDisplay}(`tint` 改叫 `color`)。见上面那条。 */
export interface ExtensionDescriptor {
	label: string;
	shortLabel: string;
	tint: string;
}

/**
 * 一个能借来当连接的 bot。
 *
 * 面板新建连接时列给主人挑,挑中的那个**整个 `config` 原样落进连接**、`platform` 落进
 * 连接的 `platform` —— 宿主看不懂 config(那归拓展自己那份 zod),只负责原样存回。
 * `platform` 是开放词表;`icon` 是 data URL(与桥协议 §5.2 同一种)。
 */
export interface ExtensionBotView<TConfig = unknown> {
	/** 绑上这个 bot 的连接该存的 config。拓展自己认得就行。 */
	config: TConfig;
	platform: string;
	name?: string;
	selfId?: string;
	icon?: string;
	/** 经由谁借来的(桥:那条接入的名字)—— 两条桥各驮一个同名 bot 时分得开。 */
	via?: string;
	/** 已经被哪条连接绑着 —— 面板标「已加过」,同一个 bot 别建两条连接。 */
	boundTo?: string;
}

/**
 * 拓展交给面板的「视图」—— v2 的 `ctx.publishView` 交的就是它(ADR-0019 决策 20 / 26–28,09-23
 * 决策 39 改过一轮)。
 *
 * 一组**封闭的积木**,由 BN 照着画;派生的东西由拓展算好交来,BN 不发明表达式语言。
 *
 * 🔴 这是 `@bilibili-notify/internal` 里 `ExtensionViewSchema` 的**手写镜像**(这个入口不许
 * import zod 与 internal),两份由宿主那头的类型断言**双向严格相等**地钉住
 * (`apps/server/src/extensions/view-shape-pin.ts`)—— 这里多一个可选键,那边就过不了类型检查。
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
	text: ExtensionRichText;
}

/** 状态的语气,同时决定卡角那团颜色。 */
export type ExtensionTone = "ok" | "warn" | "error" | "off";

/**
 * 一段字:一个字符串,或者一串片段。片段只有五种 —— 字、加粗、等宽、一个时刻(浏览器按
 * 「N 分钟前」画,`suffix` 接在后面)、BN 在浏览器里现算的地址。
 */
export type ExtensionRichText = string | readonly ExtensionRichRun[];
export type ExtensionRichRun =
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
	subtitle?: ExtensionRichText;
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
			items: readonly { label: string; value: ExtensionRichText; tone?: ExtensionTone }[];
	  }
	| {
			type: "table";
			title?: string;
			count?: boolean;
			empty?: ExtensionRichText;
			columns: readonly ExtensionTableColumn[];
			rows: readonly (readonly ExtensionTableCell[])[];
	  }
	| {
			type: "notice";
			tone: "info" | "warn" | "error";
			text: ExtensionRichText;
			button?: ExtensionButton;
	  }
	| {
			type: "copy";
			label: string;
			value: string | { host: "extensionUrl" };
			note?: ExtensionRichText;
	  }
	/** `image` 是 {@link ExtensionView.images} 里的键。 */
	| { type: "qr"; image: string; caption?: ExtensionRichText }
	| { type: "button"; button: ExtensionButton };
