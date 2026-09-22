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
 * 两样一起交、一起有:只有注册了推送源的(也就是跑着的)拓展才有,缺一样面板就画不全。
 */
export interface ExtensionPushView {
	display: ExtensionDisplay;
	connectionFields: readonly ExtensionScalarField[];
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
 * 拓展交给面板的「视图」—— v2 的 `ctx.publishStatus` 交的就是它(ADR-0019 决策 20 / 26–28)。
 *
 * 一组**封闭的积木**,由 BN 照着画;派生的东西由拓展算好交来,BN 不发明表达式语言。
 * 🔴 这是 `@bilibili-notify/internal` 里 `ExtensionViewSchema` 的**手写镜像**(这个入口不许
 * import zod 与 internal);宿主把校验过的视图当这个类型交出去,两份由宿主那头的类型检查钉住。
 * 不合规矩的视图宿主不画,换成一条说清哪里不对的错误提示。
 */
export interface ExtensionView {
	/** 拓展列表页那一行。 */
	summary?: { tone?: ExtensionTone; text: ExtensionRichText };
	/** 挂在头卡正文里的积木。 */
	page?: readonly ExtensionBlock[];
	/** 列表设置项的 key → 项的 id → 那一项在卡上的样子。 */
	items?: Readonly<Record<string, Readonly<Record<string, ExtensionItemView>>>>;
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

/** 调拓展的按钮(清单 `actions` 里声明),或者让 BN 改**这一项**的一格设置的按钮。 */
export type ExtensionButton =
	| { label: string; action: string }
	| { label: string; set: Readonly<Record<string, string | number | boolean>> };

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

/** 表格的一格 —— 样子跟着那一列的种类走。 */
export type ExtensionTableCell =
	| { image?: string; fallback: string }
	| string
	| { text: string; sub?: string };

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
			rows: readonly (readonly unknown[])[];
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
	| { type: "qr"; image: string; caption?: ExtensionRichText }
	| ({ type: "button" } & ExtensionButton);
