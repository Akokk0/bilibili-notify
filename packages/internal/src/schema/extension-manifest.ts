import { z } from "zod";

/**
 * 宿主给拓展的那份契约的**主版本**。
 *
 * 只比主版本(同桥接协议 v1 那条规矩):契约加一格不该把已经装好的拓展全判死,而改一格
 * 的语义则必须让旧拓展**停在门外**。宿主与清单对不上就是「不加载 + 说清楚为什么」——
 * 加载了再炸的话,炸在哪一半全凭运气。
 */
export const EXTENSION_API_VERSION = 1;

/**
 * 这个拓展开的是哪一口。
 *
 * 只有两口(ADR-0012):**推送源**接进「推送目标」,**订阅源**接进「订阅 UP 主」。
 * 面板要在不加载代码的前提下把卡片归类,所以它写在清单里而不是靠代码注册时才知道。
 */
export const EXTENSION_PROVIDES = ["push", "subscription"] as const;
export const ExtensionProvidesSchema = z.enum(EXTENSION_PROVIDES);
export type ExtensionProvides = z.infer<typeof ExtensionProvidesSchema>;

/**
 * 拓展 id —— 它同时是**三个地方的一段**:URL(`/ext/:id/*`)、装载目录
 * (`<dataDir>/extensions/<id>/`)、失败记账的键。所以「非空字符串」远远不够,而且必须
 * **在清单校验这一步**就拦住:放过去之后每一处都得自己防一遍,漏一处就是路径穿越。
 *
 * 一律**小写** —— 不是洁癖:macOS 与 Windows 的文件系统不分大小写,`Douyin` 与 `douyin`
 * 会落进同一个目录,而 URL 那一段是分的,两边对不上。
 */
/** id 的一段:小写字母、数字、连字符,首尾必须是字母或数字。 */
const ID_SEGMENT = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";

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
export const ExtensionVersionSchema = z
	.string()
	.regex(
		/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
		"拓展版本号必须是 semver,如 1.0.0 或 1.0.0-alpha.1",
	);

/**
 * `extension.json` —— 拓展包的清单。
 *
 * **它要在代码跑起来之前就把话说全**:面板列出「装了但没启用」的拓展、执行之前判兼容、
 * 失败记账拿得到身份,这三件事都发生在 `import()` 之前(ADR-0012 决策 8)。所以清单里
 * 不放任何「要跑一下才知道」的东西 —— config 的 zod 与字段表都由代码那边交,加载时对表。
 */
export const ExtensionManifestSchema = z.object({
	id: ExtensionIdSchema,
	name: z.string().min(1),
	/** 一句话说清它是干嘛的 —— 拓展页卡片上印的就是这句。 */
	description: z.string().min(1),
	version: ExtensionVersionSchema,
	/** 拿它跟 {@link EXTENSION_API_VERSION} 比,对不上就不加载。 */
	apiVersion: z.number().int().min(1),
	provides: z.array(ExtensionProvidesSchema).min(1),
	/**
	 * 卡片上的图标,一段 SVG。**可选** —— 没有就退回灰方章,不是拒绝加载的理由。
	 * 内容在加载时过白名单(拓展能独立发版的代价:图标不能住在主程序的闭表里)。
	 */
	icon: z.string().max(64_000).optional(),
});
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
