/**
 * 设置 / 连接配置表单里的一格的形状,面板照它画、宿主照它对表。中立概念:今天只有拓展交,
 * 内置集成第 4 期交同一种(ADR-0025 决策 3)。
 */

/**
 * 一格**设置项 / 连接配置项** —— 面板照它画一栏,按**数据类型**分、不按控件分
 * (ADR-0019 决策 17)。它落在清单里(`settings.fields` / `contributes.push.settingsFields`):
 * 官方拓展由构建从规则导出(规则上写 {@link SettingsFieldMeta},`settingsFieldsFromSchema`),
 * 手写清单的与代码里那份 zod 是两份声明。两种都在加载时对表。
 *
 * 🔴 **这是清单那份 schema 的手写镜像**:宿主把清单里读出来的格原样交给面板,所以
 * `SettingsField` 必须与它严格相等 —— `manifest-shape-pin.ts` 的类型检查会替两份钉住。
 *
 * 🔴 `secret: true` 同时是**备份脱敏的依据**。脱敏本来靠一份键名黑名单,而集成的键名归
 * 集成自己起 —— 不声明的话,那个 token 会原样躺在主人发出去求助的备份文件里。
 */
export type SettingsField = SettingsScalarField | SettingsListField;

/** 单值的那几种。推送源的连接配置项只能是它们(连接的 config 是扁平的一层键值)。 */
export type SettingsScalarField =
	| SettingsStringField
	| SettingsNumberField
	| SettingsBooleanField
	| SettingsEnumField;

/** 内置连接描述使用的扩展;拓展清单仍只收 SettingsScalarField。 */
export type ConnectionSettingsField = (SettingsScalarField | SettingsRecordField) & {
	/** 这一格只在指定的分支里显示。 */
	when?: { key: string; value: string };
	/** 切换分支时整体重建设置,保留声明的共用值。 */
	variants?: Readonly<
		Record<
			string,
			{
				settings: Readonly<Record<string, unknown>>;
				preserve: readonly { key: string; truthy?: boolean }[];
			}
		>
	>;
	/** 同一适配器的候选平台可有不同的提示文字。 */
	byPlatform?: Readonly<Record<string, { description?: string; placeholder?: string }>>;
	/** 端口字段旁显示由访问主机与端口组成的接入地址。 */
	listener?: { scheme: "ws" };
};

interface SettingsRecordField extends SettingsFieldBase {
	type: "record";
	default?: Record<string, string>;
}

interface SettingsStringField extends SettingsFieldBase {
	type: "string";
	default?: string;
	placeholder?: string;
	secret?: boolean;
	multiline?: boolean;
	monospace?: boolean;
	/** 面板替主人生成一串,新建时明文显示一次。 */
	generate?: boolean;
}

interface SettingsNumberField extends SettingsFieldBase {
	type: "number";
	default?: number;
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
}

interface SettingsBooleanField extends SettingsFieldBase {
	type: "boolean";
	default?: boolean;
}

interface SettingsEnumField extends SettingsFieldBase {
	type: "enum";
	/**
	 * 选项图标是图片的 base64 data URL(png / jpeg / webp / svg),面板当 `<img>` 画;
	 * 清单格式那一步已经把它限定成图片、封了顶。
	 */
	options: readonly { value: string; label: string; icon?: string }[];
	default?: string;
}

/**
 * 对象数组:每一项一张卡。只嵌一层 —— 项里只有单值。
 *
 * 项的 `id` 由 BN 生成、藏起来、不许改(视图按它把积木挂到那一项上),不在 `fields` 里。
 */
export interface SettingsListField extends SettingsFieldBase {
	type: "list";
	fields: readonly SettingsScalarField[];
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

interface SettingsFieldBase {
	/** 值落在 `settings[key]` / `config[key]` —— **同时是这一栏的身份**。 */
	key: string;
	label: string;
	description?: string;
	required?: boolean;
}

/**
 * 规则上给人看的那几格,写在 zod 4 的 `.meta({...})` 里(`z.string().meta({ label: "名字" } satisfies SettingsFieldMeta)`),
 * 由 `settingsFieldsFromSchema` 与规则本身一起导出成 {@link SettingsField}。**类型、默认值、必填、上下限、
 * 枚举的取值读规则本身,这里不写第二份。**
 *
 * - 写了 `label` 的键才出一栏;不给人填的键(连接里由拓展交的、列表项的 `id`)不写。
 * - 每一格只用在对应的那一种上(下面按种类分组),写在别的种类上导出时抛。
 * - meta 写在哪一层都行:`.optional()` / `.default()` 套在外面也读得到。
 */
export interface SettingsFieldMeta {
	label: string;
	description?: string;
	// string
	placeholder?: string;
	secret?: boolean;
	multiline?: boolean;
	monospace?: boolean;
	generate?: boolean;
	// number(上下限读规则的 `.min()` / `.max()`)
	step?: number;
	unit?: string;
	// enum:取值 → 这个选项的标签与图标,取值要与规则里的一一对上
	options?: Readonly<Record<string, { label: string; icon?: string }>>;
	// list(项里的格读项那份 `z.object` 的 meta)
	title?: string;
	itemLabel?: string;
	mark?: string;
	toggle?: string;
	newItemCopy?: SettingsListField["newItemCopy"];
	removeWarning?: string;
}
