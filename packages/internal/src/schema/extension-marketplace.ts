import { z } from "zod";
import {
	ExtensionIdSchema,
	ExtensionVersionSchema,
	extensionNamespaceOf,
	IdSegmentSchema,
} from "./extension-manifest";

/**
 * 拓展市场的索引(`marketplace.json`,ADR-0013)。
 *
 * 一份索引 = 一个源。官方源的这份被签名信封包着(签名与新鲜度在 server 那头验,同自主升级
 * 的清单一套);第三方源的就是这份 JSON 本身,不签 —— 谁控制了那个地址谁就能换内容,这正是
 * 添加第三方源时要提示的风险。两种源**同一个 schema**,差别只在 {@link checkMarketplaceIndex}
 * 那两条规矩。
 *
 * 每个 id **每档只列最新那一版**:一条正式(`prerelease` 缺省 / false)+ 一条预发布
 * (`prerelease: true`),最多两条。「有没有新版」于是仍然是一次版本比较,索引永远很小;
 * 老版本靠发布页还能手动下。两档并存是因为**打了一个 alpha tag 不该让稳定渠道的人看不见
 * 这个拓展** —— 整条被预发布那版顶掉的话,市场上那张卡会消失,已经装着的还会被标成
 * 「从别处装的」。挑哪一条给谁看是宿主那头的事(`apps/server/src/extensions/marketplace.ts`)。
 */
const HttpsUrl = z.string().url().startsWith("https://");

/** 源的命名空间:就是 id 的那一段({@link IdSegmentSchema}),只是另加一条长度上限。 */
export const MarketplaceNamespaceSchema = IdSegmentSchema.min(1).max(32);

export const MarketplaceEntrySchema = z.object({
	id: ExtensionIdSchema,
	name: z.string().min(1),
	description: z.string().default(""),
	version: ExtensionVersionSchema,
	/** 它要的宿主契约版本;对不上宿主的就标灰「要先升级 BN」。 */
	apiVersion: z.number().int().positive(),
	/** 预发布条目只在 BN 自己的更新渠道也是预发布时才显示。 */
	prerelease: z.boolean().optional(),
	/** 去哪下、多大、校验和 —— 与自主升级的载荷那三格同一套约束(同样只挡我们自己写错)。 */
	package: z.object({
		url: HttpsUrl,
		sha256: z.string().regex(/^[0-9a-f]{64}$/),
		size: z.number().int().positive(),
	}),
	/** 这一版的发布页;下不动时给用户的落脚点。 */
	releaseUrl: HttpsUrl.optional(),
	/** 给用户看的一句话说明。 */
	notes: z.string().optional(),
});
export type MarketplaceEntry = z.infer<typeof MarketplaceEntrySchema>;

export const MarketplaceIndexSchema = z.object({
	/** 这个源叫什么(面板上「来自 ○○」)。 */
	name: z.string().min(1).max(64),
	/** 第三方源必填、官方源没有:它列的每个 id 都得是 `<namespace>.xxx`。 */
	namespace: MarketplaceNamespaceSchema.optional(),
	owner: z.object({ name: z.string().min(1), url: HttpsUrl.optional() }).optional(),
	/** 签发时间(epoch 秒)。官方源必填 —— 它是签名索引的新鲜度,防加速站回放一份旧的。 */
	issuedAt: z.number().int().positive().optional(),
	/** 事后撤回的版本,`id@version`。已装的那版卡片上标红一句,索引里也不再提供下载。 */
	revoked: z.array(z.string()).optional(),
	extensions: z.array(MarketplaceEntrySchema),
});
export type MarketplaceIndex = z.infer<typeof MarketplaceIndexSchema>;

export type MarketplaceIndexCheck = { ok: true } | { ok: false; err: string };

/**
 * 解析得过之后再对一遍**这个源有没有资格发这些 id**:
 * - 官方源:条目 id 不带命名空间(没有点的 id 就是官方的),且必须有 `issuedAt`;
 * - 第三方源:必须声明 `namespace`,每个条目都得在自己的命名空间里 —— 列一个 `bridge`
 *   是冒充官方,列一个 `bob.xxx` 是冒用别人的命名空间,都拒。
 * - 两种都不许同一个 id 在**同一档**里列两遍(正式一条、预发布一条,合计最多两条):
 *   同一档两条的话「那一档的最新版」就没法唯一,挑哪条给用户只能靠数组顺序。
 */
export function checkMarketplaceIndex(
	index: MarketplaceIndex,
	opts: { official: boolean },
): MarketplaceIndexCheck {
	const seen = new Set<string>();
	for (const entry of index.extensions) {
		const pre = entry.prerelease === true;
		const key = `${entry.id}@${pre ? "pre" : "stable"}`;
		if (seen.has(key))
			return { ok: false, err: `索引里 ${entry.id} 的${pre ? "预发布" : "正式"}版列了两遍` };
		seen.add(key);
	}
	if (opts.official) {
		if (index.issuedAt === undefined) return { ok: false, err: "官方索引缺 issuedAt" };
		const stray = index.extensions.find((entry) => extensionNamespaceOf(entry.id) !== undefined);
		if (stray) return { ok: false, err: `官方索引里的 ${stray.id} 带了命名空间` };
		return { ok: true };
	}
	if (!index.namespace) return { ok: false, err: "第三方源必须声明 namespace" };
	const ns = index.namespace;
	const stray = index.extensions.find((entry) => extensionNamespaceOf(entry.id) !== ns);
	if (stray) return { ok: false, err: `${stray.id} 不在这个源的命名空间「${ns}」里` };
	return { ok: true };
}

/** 这一版被这个源撤回了吗(`revoked` 里有 `id@version`)。 */
export function isMarketplaceRevoked(
	index: MarketplaceIndex,
	id: string,
	version: string,
): boolean {
	return index.revoked?.includes(`${id}@${version}`) ?? false;
}
