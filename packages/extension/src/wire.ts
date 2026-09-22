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
			/** 选项图标是一段 SVG,宿主读清单那一刻已经过过白名单。 */
			options: readonly { value: string; label: string; icon?: string }[];
			default?: string;
	  });

/** 对象数组:每一项一张卡。只嵌一层 —— 项里只有单值。 */
export interface ExtensionListField extends ExtensionFieldBase {
	type: "list";
	fields: readonly ExtensionScalarField[];
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
