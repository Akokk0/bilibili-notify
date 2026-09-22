import { z } from "zod";

/**
 * 宿主认的**契约档位区间** `[min, current]`(ADR-0019 决策 18)。
 *
 * 清单里的 `apiVersion` 是拓展**要的那一档**。落在区间里就收;高于 `current` 是给更新的
 * BN 写的,低于 `min` 是给已经删掉退路的旧契约写的 —— 两头都是「不加载 + 说清楚为什么」,
 * 加载了再炸的话,炸在哪一半全凭运气。
 *
 * - 契约**加东西**(清单多一段、ctx 多一格)= 抬 `current`:要新东西的拓展写新的那档,
 *   旧 BN 当场说「版本不合」,而不是装进去才发现少了一块。
 * - **不兼容**的改动 = 抬 `min` 并删掉对应的退路。
 *
 * 现在:v1 是老格式(外观与配置项写在代码里,只剩桥在用),v2 是把静态声明搬进清单的那份。
 */
export interface ExtensionApiRange {
	readonly min: number;
	readonly current: number;
}
export const EXTENSION_API_RANGE: ExtensionApiRange = Object.freeze({ min: 1, current: 2 });

/**
 * 这个拓展开的是哪一口。
 *
 * 只有两口(ADR-0012):**推送源**接进「推送目标」,**订阅源**接进「订阅 UP 主」。
 * 面板要在不加载代码的前提下把卡片归类,所以它得从清单里读得出来:v1 单写一格
 * `provides`,v2 由 `contributes` 的键推出来({@link manifestProvides})。
 */
export const EXTENSION_PROVIDES = ["push", "subscription"] as const;
export const ExtensionProvidesSchema = z.enum(EXTENSION_PROVIDES);
export type ExtensionProvides = z.infer<typeof ExtensionProvidesSchema>;

/**
 * 一个拓展现在处于什么状态 —— 与主人按的那个开关是**两件事**:开关开着而它没跑,
 * 恰恰是最需要看见的那一格。宿主的装载器产出它,面板契约原样转出,所以只在这儿写一份。
 */
export const EXTENSION_RUN_STATES = [
	/** 跑着。 */
	"running",
	/** 主人把开关关了。没启用的拓展一行代码都不会被 import。 */
	"disabled",
	/** 连着加载失败,自动停用了。 */
	"blocked",
	/** 这一次加载炸了。 */
	"failed",
	/** 清单读不了 / 与目录对不上 / 缺入口。 */
	"unreadable",
	/** 给别的宿主契约版本写的。 */
	"incompatible",
] as const;
export type ExtensionRunState = (typeof EXTENSION_RUN_STATES)[number];

/**
 * 拓展 id —— 它同时是**三个地方的一段**:URL(`/ext/:id/*`)、装载目录
 * (`<dataDir>/extensions/<id>/`)、失败记账的键。所以「非空字符串」远远不够,而且必须
 * **在清单校验这一步**就拦住:放过去之后每一处都得自己防一遍,漏一处就是路径穿越。
 *
 * 一律**小写** —— 不是洁癖:macOS 与 Windows 的文件系统不分大小写,`Douyin` 与 `douyin`
 * 会落进同一个目录,而 URL 那一段是分的,两边对不上。
 */
/**
 * id 的一段:小写字母、数字、连字符,首尾必须是字母或数字。
 *
 * 导出的是**这一份**,不是抄一份 —— 市场索引的 `namespace`(ADR-0013)长的就是 id 的
 * 一段:各写一份正则的话,哪天放宽一边,另一边会静默把合法的命名空间判成非法。
 */
export const ID_SEGMENT = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";

/** 光是「一段」的 schema;长度上限由用它的人各自加(id 是 64,命名空间是 32)。 */
export const IdSegmentSchema = z
	.string()
	.regex(new RegExp(`^${ID_SEGMENT}$`), "只能是小写字母、数字与连字符,且首尾必须是字母或数字");

/**
 * 形状是 `<名字>` 或 `<命名空间>.<名字>`(ADR-0013):**没有点的 id 保留给官方源**,第三方源
 * 发的拓展必须带自己的命名空间。命名空间烧进 id 而不是装的时候拼 —— id 在 BN 里是落盘的
 * 键(连接的 `extensionId`、设置槽、目录名),它必须与用户怎么称呼那个源无关。
 * 一个点、两段各自非空,所以拼不出 `..`,当目录名与 URL 段都安全。
 */
export const ExtensionIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(
		new RegExp(`^${ID_SEGMENT}(?:\\.${ID_SEGMENT})?$`),
		"拓展 id 只能是小写字母、数字与连字符(可用一个点分出命名空间),且每段首尾必须是字母或数字",
	);

/** 命名空间那一段;没有点 = 官方源的拓展,回 `undefined`。 */
export function extensionNamespaceOf(id: string): string | undefined {
	const dot = id.indexOf(".");
	return dot < 0 ? undefined : id.slice(0, dot);
}

/**
 * 拓展版本号 —— 一个真 semver(`1.0.0` / `1.0.0-alpha.1`)。
 *
 * 它是**失败记账的另一半**:记账按 id + 版本(ADR-0012 后果段),换一版就该重新给机会。
 * 所以它必须能比大小、必须一眼看得出「换过版本」——`latest` 这种活标签做不到。
 */
export const ExtensionVersionSchema = z.string().regex(
	// 与 tag 守卫(assert-extension-tag.sh)、并索引脚本(marketplace-index.mjs 的 SEMVER)
	// 是同一把尺子:不收前导零、不收 build 元数据。三把对同一批样本的答案由
	// marketplace-index.test.mjs 钉着。
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/,
	"拓展版本号必须是 semver,如 1.0.0 或 1.0.0-alpha.1",
);

/*
 * ---- `extension.json` —— 拓展包的清单 ----------------------------------------------
 *
 * **它要在代码跑起来之前就把话说全**:面板列出「装了但没启用」的拓展、执行之前判兼容、
 * 失败记账拿得到身份,这三件事都发生在 `import()` 之前(ADR-0012 决策 8)。所以清单里不放
 * 任何「要跑一下才知道」的东西 —— 而表单声明、外观、开哪一口**是静态数据**,从来不属于
 * 那一类:v2 把它们全搬进了清单(ADR-0019 决策 16),代码那边只剩行为与 zod 校验。
 *
 * 读法固定是**先单读 `apiVersion`,再按那一档的格式校验其余**({@link parseExtensionManifest})
 * —— 以后格式再变,旧宿主说的是「版本不合」,而不是「清单读不了」。
 */

/**
 * **身份那几格** —— 每一档清单都有、而且读法永远不变。
 *
 * 版本不合的拓展也要在面板上占一行、写得出「××× 3.0.0 要更新的 BN」,所以这几格是
 * 跨档位的承诺:它们以后只许加可选格,不许改。
 */
const identityShape = {
	id: ExtensionIdSchema,
	name: z.string().min(1),
	/** 一句话说清它是干嘛的 —— 拓展页卡片上印的就是这句。 */
	description: z.string().min(1),
	version: ExtensionVersionSchema,
	/**
	 * 卡片上的图标,一段 SVG。**可选** —— 没有就退回灰方章,不是拒绝加载的理由。
	 * 内容在加载时过白名单(拓展能独立发版的代价:图标不能住在主程序的闭表里)。
	 */
	icon: z.string().max(64_000).optional(),
};

/** 不认识的档位只按这几格读 —— 其余部分可能是我们根本不认识的格式,不挑它的毛病。 */
const ExtensionIdentitySchema = z.object(identityShape);
export type ExtensionIdentity = z.infer<typeof ExtensionIdentitySchema>;

/**
 * v1:外观与配置项写在代码里(`registerPushSource` 时交),清单只报开哪一口。
 *
 * **格式已冻结、照旧宽松**(多出来的键丢掉):已经发出去的 v1 包不能因为宿主升级就变成
 * 读不了。现在只剩桥还在用,它迁到 v2、再抬 `min` 之后整段删掉。
 */
const ExtensionManifestV1Schema = z.object({
	...identityShape,
	apiVersion: z.literal(1),
	provides: z.array(ExtensionProvidesSchema).min(1),
});
export type ExtensionManifestV1 = z.infer<typeof ExtensionManifestV1Schema>;

// ---- v2 的积木 -----------------------------------------------------------------------

/**
 * 设置项的键 —— 值落在 `settings[key]` / `config[key]`,面板还拿它拼表单路径。
 *
 * 字母开头:顺手挡住 `__proto__` 这一类;不带点与连字符:面板拼路径用的就是点。
 */
const FieldKeySchema = z
	.string()
	.max(64)
	.regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "设置项的 key 只能是字母开头的字母、数字与下划线");

const fieldBase = {
	key: FieldKeySchema,
	label: z.string().min(1),
	description: z.string().optional(),
	required: z.boolean().optional(),
};

const StringFieldSchema = z.strictObject({
	...fieldBase,
	type: z.literal("string"),
	default: z.string().optional(),
	placeholder: z.string().optional(),
	/** 面板遮住、备份脱敏 —— 拓展的键名归拓展自己起,密钥必须声明出来,不能靠猜。 */
	secret: z.boolean().optional(),
	multiline: z.boolean().optional(),
	monospace: z.boolean().optional(),
	/** 面板替主人生成一串(格式由 BN 定),新建时明文显示一次(ADR-0019 决策 21)。 */
	generate: z.boolean().optional(),
});

const NumberFieldSchema = z.strictObject({
	...fieldBase,
	type: z.literal("number"),
	default: z.number().optional(),
	min: z.number().optional(),
	max: z.number().optional(),
	step: z.number().positive().optional(),
	unit: z.string().optional(),
});

const BooleanFieldSchema = z.strictObject({
	...fieldBase,
	type: z.literal("boolean"),
	default: z.boolean().optional(),
});

/**
 * 拓展交的图片(选项图标、表格的 icon 格)的上限 —— 整段 data URL 的字数。与桥协议里 bot 图标
 * 那条(`BRIDGE_BOT_ICON_MAX_BYTES`)同一个数:拓展包进不来 internal,只能各写一份。
 */
export const EXTENSION_IMAGE_MAX_CHARS = 32 * 1024;

/**
 * 拓展交的图片 —— **只收图片的 base64 data URL**,面板一律当 `<img>` 画(ADR-0019 决策 31)。
 *
 * 不过 SVG 白名单:`<img>` 里的 SVG 不跑脚本、拉不进外部资源,而白名单每宽一格都是把外来标记
 * 塞进页面。不收 http(s) 地址:面板一开就去对家点名,不是图标该有的本事。
 */
export const ExtensionImageSchema = z
	.string()
	.max(EXTENSION_IMAGE_MAX_CHARS, "图片不能超过 32 KB")
	.regex(
		/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/,
		"图片只收 png / jpeg / webp / svg 的 base64 data URL",
	);

const EnumFieldSchema = z.strictObject({
	...fieldBase,
	type: z.literal("enum"),
	options: z
		.array(
			z.strictObject({
				value: z.string().min(1),
				label: z.string().min(1),
				/** 选项卡片上那枚图标(桥的 koishi / AstrBot logo)。 */
				icon: ExtensionImageSchema.optional(),
			}),
		)
		.min(1),
	default: z.string().optional(),
});

/** 一格「单值」设置项 —— 列表的每一项、推送源的连接配置项都只能由它们拼。 */
const ScalarFieldSchema = z.discriminatedUnion("type", [
	StringFieldSchema,
	NumberFieldSchema,
	BooleanFieldSchema,
	EnumFieldSchema,
]);

/** 形状宽松的一格,只给 {@link checkFieldList} 用 —— 四种单值与列表都能塞进来。 */
interface FieldLike {
	key: string;
	type: string;
	default?: unknown;
	required?: boolean;
	min?: number;
	max?: number;
	options?: readonly { value: string }[];
	// 列表才有的那几格
	fields?: readonly FieldLike[];
	title?: string;
	mark?: string;
	toggle?: string;
	newItemCopy?: readonly ({ field: string } | { host: string })[];
}

/** 列表项里保留给 BN 的键 —— 项的身份,由 BN 生成、藏起来、不许改(ADR-0019 决策 29)。 */
export const LIST_ITEM_ID_KEY = "id";

/**
 * 列表自己声明的那几格引用(`title` / `mark` / `toggle` / `newItemCopy`)必须指到项里一格、
 * 类型也对得上 —— 指歪了的话面板上那张卡就少一块,而没人报错。
 */
function checkListRefs(list: FieldLike, at: number, ctx: z.RefinementCtx): void {
	const items = list.fields ?? [];
	const find = (key: string | undefined) => items.find((item) => item.key === key);
	const issue = (path: (string | number)[], message: string) =>
		ctx.addIssue({ code: "custom", path: [at, ...path], message });

	const title = find(list.title);
	if (title?.type !== "string" || title.required !== true) {
		issue(["title"], `title 要指向项里一格必填的 string,"${list.title}" 不是`);
	}
	if (list.mark !== undefined && find(list.mark)?.type !== "enum") {
		issue(["mark"], `mark 要指向项里一格 enum,"${list.mark}" 不是`);
	}
	if (list.toggle !== undefined && find(list.toggle)?.type !== "boolean") {
		issue(["toggle"], `toggle 要指向项里一格 boolean,"${list.toggle}" 不是`);
	}
	list.newItemCopy?.forEach((entry, i) => {
		if ("field" in entry && find(entry.field)?.type !== "string") {
			issue(["newItemCopy", i, "field"], `newItemCopy 要指向项里一格 string,"${entry.field}" 不是`);
		}
	});
	items.forEach((item, i) => {
		if (item.key === LIST_ITEM_ID_KEY) {
			issue(["fields", i, "key"], `项里的 "${LIST_ITEM_ID_KEY}" 由 BN 生成、不许声明`);
		}
	});
}

/**
 * 一张表里跨格 / 格内跨字段的规矩 —— 单格的 schema 表达不了的那些。
 *
 * 每一条都点名到具体那一格:拓展是我们自己写的,信息给足才修得快。
 */
function checkFieldList(fields: readonly FieldLike[], ctx: z.RefinementCtx): void {
	const seen = new Set<string>();
	fields.forEach((field, i) => {
		if (seen.has(field.key)) {
			ctx.addIssue({
				code: "custom",
				path: [i, "key"],
				message: `"${field.key}" 摆了两栏 —— 哪一栏说了算没有答案`,
			});
		}
		seen.add(field.key);
		if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
			ctx.addIssue({ code: "custom", path: [i, "min"], message: "min 比 max 还大" });
		}
		if (field.options) {
			const values = new Set<string>();
			field.options.forEach((option, j) => {
				if (values.has(option.value)) {
					ctx.addIssue({
						code: "custom",
						path: [i, "options", j, "value"],
						message: `选项 "${option.value}" 摆了两个`,
					});
				}
				values.add(option.value);
			});
			if (typeof field.default === "string" && !values.has(field.default)) {
				ctx.addIssue({
					code: "custom",
					path: [i, "default"],
					message: `默认值 "${field.default}" 不是选项之一`,
				});
			}
		}
		if (field.type === "list") checkListRefs(field, i, ctx);
	});
}

/** 列表:对象数组,每一项一张卡(ADR-0019 决策 21)。**只嵌一层** —— 项里不能再有列表。 */
const ListFieldSchema = z.strictObject({
	...fieldBase,
	type: z.literal("list"),
	fields: z.array(ScalarFieldSchema).min(1).max(64).superRefine(checkFieldList),
	/** 哪一格当卡片标题 —— 必须是项里一格必填的 string。 */
	title: FieldKeySchema,
	/** 一项叫什么(「接入」)—— 「新建接入」「还没有接入」「删掉这条接入?」。不给就用 `label`。 */
	itemLabel: z.string().min(1).max(16).optional(),
	/** 哪个 enum 的选中项图标当卡片左上的方块。 */
	mark: FieldKeySchema.optional(),
	/** 哪一格 boolean 画成卡上的「停用 / 启用」;关着的项 BN 盖成「已停用」。 */
	toggle: FieldKeySchema.optional(),
	/**
	 * 新建弹窗底部要成对复制的几样(ADR-0009 决策 21「token 与地址成对交出去」):BN 现算的
	 * 值,或者本项的某一格 string(新建时它还是明文)。
	 */
	newItemCopy: z
		.array(
			z.union([
				z.strictObject({ host: z.literal("extensionUrl"), label: z.string().min(1) }),
				z.strictObject({ field: FieldKeySchema }),
			]),
		)
		.max(8)
		.optional(),
	/** 删除确认里「删了会怎样」那句 —— 安全提示,通用说法说不出来。 */
	removeWarning: z.string().min(1).optional(),
});

const FieldSchema = z.discriminatedUnion("type", [
	StringFieldSchema,
	NumberFieldSchema,
	BooleanFieldSchema,
	EnumFieldSchema,
	ListFieldSchema,
]);
/** 一格设置项 —— 按**数据类型**分,不按控件分,与 zod 一一对应(ADR-0019 决策 17)。 */
export type ExtensionManifestField = z.infer<typeof FieldSchema>;

/**
 * `{ fields: [...] }` —— 表单永远是这一个形状。
 *
 * 推送源的连接配置项只收单值:连接的 config 是**扁平的一层键值**,面板那侧生成的是
 * `config[key] = v`。
 */
const SettingsSchema = z.strictObject({
	fields: z.array(FieldSchema).max(64).superRefine(checkFieldList),
});
const ConnectionSchema = z.strictObject({
	fields: z.array(ScalarFieldSchema).max(64).superRefine(checkFieldList),
});

/**
 * 颜色进样式,而清单来自第三方 —— 只收 hex,别的写法(`url(...)`、带分号的)一律拒。
 */
const HexColorSchema = z
	.string()
	.regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "颜色只收 hex,如 #fe2c55");

/** 一个口在界面上的样子(ADR-0012 决策 46 那三格,`tint` 改名 `color`)。 */
const displayShape = {
	/** 全名:新建连接 / 平台选择那一排。 */
	label: z.string().min(1).max(64),
	/** 短名:卡片上那个方章。 */
	shortLabel: z.string().min(1).max(8),
	color: HexColorSchema,
};
const PushDisplaySchema = z.strictObject(displayShape);
const SubscriptionDisplaySchema = z.strictObject({
	...displayShape,
	/** 这个平台管「一条动态」叫什么(抖音:作品)。不给就叫「动态」。 */
	postNoun: z.string().min(1).max(8).optional(),
});
export type ExtensionManifestDisplay = z.infer<typeof PushDisplaySchema>;

/**
 * 订阅源会报的事件种类(ADR-0019 决策 4)—— 中立名,BN 入口处映射到
 * `dynamic / live / liveEnd`。配置弹层只列这个源报的那几种。
 */
export const SUBSCRIPTION_EVENT_KINDS = ["post", "liveStart", "liveEnd"] as const;
export type SubscriptionEventKind = (typeof SUBSCRIPTION_EVENT_KINDS)[number];

/**
 * 包内路径:相对拓展根、不带 `./`、不许 `..` —— 每一段都得以字母或数字开头,
 * 所以 `.`、`..`、空段都拼不出来。
 */
const PACKAGE_PATH_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";
const PackagePathSchema = z
	.string()
	.max(128)
	.regex(
		new RegExp(`^${PACKAGE_PATH_SEGMENT}(?:/${PACKAGE_PATH_SEGMENT})*$`),
		"包内路径要相对拓展根写(如 card-skin),不带 ./、不许 ..",
	);

const ContributesSchema = z
	.strictObject({
		push: z
			.strictObject({
				display: PushDisplaySchema,
				/** 主人新建连接时要填的那几栏。桥那种「连接是挑出来的」可以不写。 */
				connection: ConnectionSchema.optional(),
			})
			.optional(),
		subscription: z
			.strictObject({
				display: SubscriptionDisplaySchema,
				events: z
					.array(z.enum(SUBSCRIPTION_EVENT_KINDS))
					.min(1)
					.refine((events) => new Set(events).size === events.length, "事件种类写重复了"),
				/** 自带的卡片皮肤目录(ADR-0019 决策 13)。 */
				cardSkin: PackagePathSchema.optional(),
			})
			.optional(),
	})
	.refine(
		(contributes) => EXTENSION_PROVIDES.some((key) => contributes[key] !== undefined),
		"contributes 至少要开一口",
	);

/**
 * 动作名 —— 它要进 URL(`POST /api/ext/:id/actions/:name`),所以只许小写字母开头的
 * 字母数字,点分段(`login.start`)。
 */
const ActionNameSchema = z
	.string()
	.max(64)
	.regex(
		/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/,
		"动作名只能是小写字母开头的字母数字,用点分段,如 login.start",
	);

/**
 * v2:静态声明全住清单(ADR-0019 决策 16)。
 *
 * **严格**:多一个键就读不了。拼错的键(`setings`)放过去就是一格静默失效的声明 ——
 * 面板上少了一栏,没人报错。格式要长新东西,跟着抬 {@link EXTENSION_API_RANGE} 的 `current`。
 */
const ExtensionManifestV2Schema = z.strictObject({
	/** 编辑器补全用,宿主不读。 */
	$schema: z.string().optional(),
	...identityShape,
	apiVersion: z.literal(2),
	/** 这个拓展自己的设置项(桥的接入名单、抖音的 cookie)。 */
	settings: SettingsSchema.optional(),
	/** 面板上能按的按钮,代码那边 `ctx.onAction` 注册(ADR-0019 决策 22)。 */
	actions: z
		.record(
			ActionNameSchema,
			z.strictObject({ label: z.string().min(1), description: z.string().optional() }),
		)
		.optional(),
	/** 开哪几口、每口的声明 —— `provides` 由它的键推出来。 */
	contributes: ContributesSchema,
});
export type ExtensionManifestV2 = z.infer<typeof ExtensionManifestV2Schema>;

export type ExtensionManifest = ExtensionManifestV1 | ExtensionManifestV2;

/** 每一档的格式。区间里有、这里没有的档位按「不认识」算。 */
const MANIFEST_SCHEMAS: Readonly<Record<number, z.ZodType<ExtensionManifest>>> = {
	1: ExtensionManifestV1Schema,
	2: ExtensionManifestV2Schema,
};

/** 只读这一格 —— 其余部分长什么样要看它。 */
const ApiVersionOnlySchema = z.object({ apiVersion: z.number().int().min(1) });

export type ExtensionManifestRead =
	| { ok: true; manifest: ExtensionManifest }
	/** 读不了。`issues` 每条都是「路径: 原因」。 */
	| { ok: false; reason: "unreadable"; issues: string[] }
	/** 给别的契约档位写的。身份那几格照样读出来了,面板要印它是谁。 */
	| { ok: false; reason: "incompatible"; identity: ExtensionIdentity; requires: number };

function issuesOf(error: z.ZodError): string[] {
	return error.issues.map((issue) => `${issue.path.join(".") || "(根)"}: ${issue.message}`);
}

/**
 * 读一份清单(已经 `JSON.parse` 过的)。
 *
 * 顺序是有讲究的:**先单读 `apiVersion`**。为将来的宿主写的清单,格式本来就可能是我们
 * 不认识的 —— 按今天的规矩挑它的毛病只会报一堆「读不了」,而真正的原因只有一条。
 */
export function parseExtensionManifest(
	raw: unknown,
	range: ExtensionApiRange = EXTENSION_API_RANGE,
): ExtensionManifestRead {
	const head = ApiVersionOnlySchema.safeParse(raw);
	if (!head.success) return { ok: false, reason: "unreadable", issues: issuesOf(head.error) };
	const requires = head.data.apiVersion;

	const schema =
		requires >= range.min && requires <= range.current ? MANIFEST_SCHEMAS[requires] : undefined;
	if (!schema) {
		const identity = ExtensionIdentitySchema.safeParse(raw);
		if (!identity.success) {
			return { ok: false, reason: "unreadable", issues: issuesOf(identity.error) };
		}
		return { ok: false, reason: "incompatible", identity: identity.data, requires };
	}

	const parsed = schema.safeParse(raw);
	if (!parsed.success) return { ok: false, reason: "unreadable", issues: issuesOf(parsed.error) };
	return { ok: true, manifest: parsed.data };
}

/** 它开的是哪几口 —— v1 照它写的,v2 由 `contributes` 的键推出来(次序固定)。 */
export function manifestProvides(manifest: ExtensionManifest): ExtensionProvides[] {
	if (manifest.apiVersion === 1) return [...manifest.provides];
	return EXTENSION_PROVIDES.filter((key) => manifest.contributes[key] !== undefined);
}

/**
 * 清单里标了 `secret` 的键 —— 备份脱敏照它抹(ADR-0019 决策 17)。设置项、列表项、推送源的
 * 连接配置项都算,排序去重。
 *
 * v1 的密钥声明写在代码里、注册推送源时才交,清单答不出来 —— 回 `undefined`,**不是空表**:
 * 在脱敏那边空表是「一格都不用抹」,`undefined` 是「问不出来,整片当密钥」。
 */
export function manifestSecretKeys(manifest: ExtensionManifest): string[] | undefined {
	if (manifest.apiVersion === 1) return undefined;
	const keys = new Set<string>();
	const collect = (fields: readonly ExtensionManifestField[]) => {
		for (const field of fields) {
			if (field.type === "string" && field.secret) keys.add(field.key);
			if (field.type === "list") collect(field.fields);
		}
	};
	collect(manifest.settings?.fields ?? []);
	collect(manifest.contributes.push?.connection?.fields ?? []);
	return [...keys].sort();
}
