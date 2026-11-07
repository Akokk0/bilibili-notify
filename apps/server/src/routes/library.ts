/** 主人上传、反复选用的素材库(ADR-0036 决策1、5)。存储与删前引用规则保持原样。 */
import type {
	LibraryFontsResponse,
	LibraryFontUploadResponse,
	LibraryImagesResponse,
	LibraryImageUploadResponse,
	ResourceImportPreviewResponse,
} from "@bilibili-notify/contract";
import {
	CARD_SKIN_UPLOAD_PREFIX,
	type CardSkinKnobOverrides,
	fail,
	type GlobalSettings,
	ok,
	type Subscription,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { Hono } from "hono";
import { AssetRejectedError } from "../assets/asset-store.js";
import { t } from "../i18n/index.js";
import {
	checkCardBgUpload,
	deleteCardBg,
	isValidCardBgId,
	listCardBg,
	MAX_CARD_BG_BYTES,
	readCardBg,
	saveCardBg,
} from "../runtime/card-assets.js";
import {
	checkFontAssetUpload,
	deleteFontAsset,
	isValidFontAssetId,
	listFontAssets,
	MAX_FONT_ASSET_BYTES,
	readFontAsset,
	saveFontAsset,
} from "../runtime/font-assets.js";
import { subscriptionIdentityLabelOf } from "../subscriptions/platform-label.js";
import { describeUsers } from "../util/failure-text.js";
import { respondFailure } from "./respond-failure.js";
import type { RouteDeps } from "./types.js";
import { uploadBodyLimit } from "./upload-limit.js";

/**
 * 引用列表里怎么称呼一条订阅:身份标签(平台名与外部 id 叫法按来源现取,B 站是「UID 12345」),主人认得出是哪一个。
 * 拼法在 contract,路由不认识任何平台(4-14 去掉了这里的 B 站分支)。
 */
type SubscriptionLabeler = (s: Subscription) => string;

/**
 * 旋钮覆盖里哪些层还选着某个资产 —— **全局那份**(按皮肤 id)与**每位 UP 那份**
 * (`overrides.cardSkinKnobs`,ADR-0014 决策 17 的 🔗)都扫。漏扫 per-UP 那层的后果是静默的:
 * 删得掉、请求成功,这位 UP 的卡出图时静静回落兜底(图不出 / 字体换回默认)。
 *
 * 不认旋钮声明,直接按值扫:这里没有皮肤清单,而「哪个 key 是图 / 字体旋钮」只有清单知道。
 * 多扫一个同形状的值也只是多拦一次删除。
 */
function knobReferences(
	globals: GlobalSettings,
	subs: Subscription[],
	hit: (value: unknown) => boolean,
	labelOf: SubscriptionLabeler,
): string[] {
	const refs: string[] = [];
	const scan = (
		bySkin: Record<string, CardSkinKnobOverrides> | undefined,
		label: (skinId: string) => string,
	): void => {
		for (const [skinId, overrides] of Object.entries(bySkin ?? {})) {
			if (Object.values(overrides ?? {}).some(hit)) refs.push(label(skinId));
		}
	};
	scan(globals.defaults.cardSkinKnobs, (skinId) => t("cards.references.skin", { skinId }));
	for (const s of subs) {
		scan(s.overrides.cardSkinKnobs, (skinId) =>
			t("cards.references.subscriptionSkin", { subscription: labelOf(s), skinId }),
		);
	}
	return refs;
}

/**
 * 收集当前配置里仍引用某图 id 的作用域(人话标签),用于删除前拦截。
 *
 * 两处算:**皮肤旋钮**(2026-09-14 起背景图的正主 —— 每套皮肤一份,值是一串 id;全局那份与
 * 每位 UP 那份都算,见 {@link knobReferences})与直播封面(`liveCoverImages`,与背景图共用
 * 同一图廊)。返回空数组 = 没人用,可安全删盘。
 *
 * ⚠️ **判据里去掉了退役的 `cardStyle.backgroundImages`(2026-09-20,整条链删干净那次)。**
 * 这是一处**主人看得见**的行为变化:存量配置里那个键还在(schema 不 strict,加载时静静
 * 剥掉),从前它算一条引用、会把删除拦下来;今天**只被它引用的图算「没人用」,删得掉**。
 * 这是对的 —— 那个键从 2026-09-19 起已经画不出任何东西(背景图走 `--bn-knob-wallpaper`
 * 旋钮),再拦着只会让主人删不掉一张早就不出现在任何卡上的图。**不是漏了。**
 *
 * ⚠️ 漏掉旋钮那一处的后果是**静默的**:删得掉、请求成功,而那套皮肤的清单里留着一个
 * 指向空气的 id,出图时静静回落渐变 —— 主人只会觉得「壁纸自己没了」。
 */
function cardBgReferences(
	globals: GlobalSettings,
	subs: Subscription[],
	id: string,
	labelOf: SubscriptionLabeler,
): string[] {
	const inCards = (cards?: { liveCoverImageIds?: string[] }): boolean =>
		cards?.liveCoverImageIds?.includes(id) ?? false;

	// 旋钮值是「一串 id」(图片旋钮)。
	const refs = knobReferences(globals, subs, (v) => Array.isArray(v) && v.includes(id), labelOf);
	if (inCards(globals.defaults.cards)) {
		refs.push(t("cards.references.globalDefault"));
	}
	// 两支订阅都算(ADR-0019 决策 47):漏看拓展订阅,它引用的图会被当成「没人用」删掉。
	for (const s of subs) {
		if (inCards(s.overrides.cards)) {
			refs.push(labelOf(s));
		}
	}
	return refs;
}

/**
 * 哪些皮肤的旋钮还选着这款字体 —— 全局那份与每位 UP 那份(ADR-0014 决策 17 的 🔗,
 * 2026-09-24)都算,见 {@link knobReferences}。**只扫旋钮**:下面说的那条老路仍然不扫。
 *
 * 🪦 2026-09-20 从四层收成一层。从前它还扫 `cardStyle.fontAsset` 的四个位置(全局基准 /
 * 全局 per-kind / UP 基准 / UP per-kind),那在字体还由卡片页管的时候是对的。今天那条路
 * **一个读者都没有**:全局那份在字体退役成旋钮时就断了,per-UP 与 per-kind 两层
 * 2026-09-20 一并摘掉(`runtime/pipeline.ts` 里那个映射函数 `cardStyleToColorOptions` 后来整个删了)。
 *
 * 继续扫它的后果是**凭一个不生效的引用拦住删除**:409 说「UP 12345 还在用」,而主人去
 * 面板上找,既找不到那个设置(入口早删了)、那款字体也根本没出现在卡上 —— 「换掉再删」
 * 这句指路指向一个不存在的地方。宁可让残留值随它去,也不留一个查不下去的 409。
 *
 * 与 {@link cardBgReferences} 不同:那边扫的 `liveCoverImages` 是**还活着**的字段。
 */
function fontAssetReferences(
	globals: GlobalSettings,
	subs: Subscription[],
	id: string,
	labelOf: SubscriptionLabeler,
): string[] {
	const asKnob = `${CARD_SKIN_UPLOAD_PREFIX}${id}`;
	return knobReferences(globals, subs, (v) => v === asKnob, labelOf);
}

export function createLibraryRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	/** 删前查引用时怎么称呼一条订阅(身份标签,按在册来源现取)。 */
	const subscriptionLabelOf: SubscriptionLabeler = (s) =>
		subscriptionIdentityLabelOf(subscriptionIdentityOf(s), {
			sources: deps.runtime.sourceRegistry,
		});

	app.post(
		"/images/import-preview",
		uploadBodyLimit(MAX_CARD_BG_BYTES, () => t("cards.upload.imageNoun")),
		async (c) => {
			const body = await c.req.parseBody().catch(() => null),
				file = body?.file;
			if (!(file instanceof File))
				return respondFailure(c, fail("invalid", t("cards.upload.missingImage")));
			const checked = checkCardBgUpload(new Uint8Array(await file.arrayBuffer()), file.type);
			if (!checked.ok) return respondFailure(c, checked);
			return c.json(
				ok({
					name: file.name,
					warnings: [],
					conflict: (await listCardBg(deps.runtime.dataRoot)).includes(file.name),
				}) satisfies ResourceImportPreviewResponse,
			);
		},
	);
	app.post(
		"/fonts/import-preview",
		uploadBodyLimit(MAX_FONT_ASSET_BYTES, () => t("cards.upload.fontNoun")),
		async (c) => {
			const body = await c.req.parseBody().catch(() => null),
				file = body?.file;
			if (!(file instanceof File))
				return respondFailure(c, fail("invalid", t("cards.upload.missingFont")));
			const checked = checkFontAssetUpload(new Uint8Array(await file.arrayBuffer()), file.name);
			if (!checked.ok) return respondFailure(c, checked);
			return c.json(
				ok({
					name: file.name,
					warnings: [],
					conflict: (await listFontAssets(deps.runtime.dataRoot)).some(
						(entry) => entry.name === file.name,
					),
				}) satisfies ResourceImportPreviewResponse,
			);
		},
	);

	// 图片上传 → 落盘 `<dataRoot>/library/images/<id>`,返回资产 id 写进皮肤的图旋钮
	// (或 `cards.liveCoverImageIds`)。素材库由卡片旋钮与直播封面共用。
	// 闸在 parseBody 之前:超大的当场回绝,别先整份读进那 512MB 的堆里。见 upload-limit.ts。
	// 超限那句里的名词在建路由时就取了字:`uploadBodyLimit` 收的是字符串,改成现取要动另外六条路由,随 4-53c。
	app.post(
		"/images",
		uploadBodyLimit(MAX_CARD_BG_BYTES, () => t("cards.upload.imageNoun")),
		async (c) => {
			const body = await c.req.parseBody().catch(() => null);
			const file = body?.file;
			if (!(file instanceof File))
				return respondFailure(c, fail("invalid", t("cards.upload.missingImage")));
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				const id = await saveCardBg(deps.runtime.dataRoot, bytes, file.type);
				return c.json(ok({ id }) satisfies LibraryImageUploadResponse);
			} catch (err) {
				// 只接「上传的东西不合规矩」(格式不认、超上限,消息是给主人看的中文);磁盘写失败之类往上抛,
				// 全局出错处理把原话记进日志、客户端拿固定一句 —— 不再把带路径的系统报错当 400 原样甩出去。
				if (err instanceof AssetRejectedError)
					return respondFailure(c, fail("invalid", err.message));
				throw err;
			}
		},
	);

	// 图廊列表 —— 列出已上传的所有背景图 id,供前端图廊选择。
	app.get("/images", async (c) => {
		const ids = await listCardBg(deps.runtime.dataRoot);
		return c.json(ok({ ids }) satisfies LibraryImagesResponse);
	});

	// 背景图服务 —— 经 id 正则校验的定向读取(绝不 serveStatic 整个 dataRoot,内有 secrets)。
	app.get("/images/:id", async (c) => {
		const id = c.req.param("id");
		const res = await readCardBg(deps.runtime.dataRoot, id);
		if (!res) return respondFailure(c, fail("not_found", t("cards.asset.bgNotFound")));
		return new Response(res.bytes, {
			headers: {
				"Content-Type": res.mime,
				...(c.req.query("download") === "1"
					? { "Content-Disposition": `attachment; filename="${id}"` }
					: {}),
				"Cache-Control": "private, max-age=31536000, immutable",
			},
		});
	});

	// 图廊删除 —— 仍被全局 / 某 UP 引用的图先拦截(`conflict`,409),避免删掉正在用的背景图。
	// 用家写进 `message`(不再另占一格 `referencedBy`)。删一张本来就不在的图算删好了:幂等,
	// 面板拿到 200 照常刷新图廊。
	app.delete("/images/:id", async (c) => {
		const id = c.req.param("id");
		if (!isValidCardBgId(id)) return respondFailure(c, fail("invalid", t("cards.asset.invalidId")));
		const referencedBy = cardBgReferences(
			deps.store.getGlobals(),
			deps.store.getSubscriptions(),
			id,
			subscriptionLabelOf,
		);
		if (referencedBy.length > 0) {
			return respondFailure(
				c,
				fail("conflict", t("cards.asset.bgInUse", { users: describeUsers(referencedBy) })),
			);
		}
		await deleteCardBg(deps.runtime.dataRoot, id);
		return c.json(ok());
	});

	// ---- 字体图廊 -----------------------------------------------------------
	//
	// 与上面背景图那四个端点同形(落盘 + id 引用 + 定向读取 + 删除前查引用)。字体单独
	// 一套目录与一套端点,不与背景图混:两者的合法后缀、体积上限、以及「列表里显示什么」
	// 都不一样(字体没有缩略图可看,列表得带原始文件名)。

	// 字体上传 → 落盘 `<dataRoot>/library/fonts/<id>`,返回资产 id 写进皮肤的字体旋钮。
	// 后缀取自**原始文件名**而不是 mime —— 浏览器给字体的 mime 一塌糊涂(同一个 .ttf 可能
	// 是 font/ttf、application/x-font-ttf、application/octet-stream 甚至空串)。
	app.post(
		"/fonts",
		uploadBodyLimit(MAX_FONT_ASSET_BYTES, () => t("cards.upload.fontNoun")),
		async (c) => {
			const body = await c.req.parseBody().catch(() => null);
			const file = body?.file;
			if (!(file instanceof File))
				return respondFailure(c, fail("invalid", t("cards.upload.missingFont")));
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				const id = await saveFontAsset(deps.runtime.dataRoot, bytes, file.name);
				return c.json(ok({ id, name: file.name }) satisfies LibraryFontUploadResponse);
			} catch (err) {
				// 同背景图那条:只接「上传的东西不合规矩」,磁盘的事往上抛。
				if (err instanceof AssetRejectedError)
					return respondFailure(c, fail("invalid", err.message));
				throw err;
			}
		},
	);

	// 字体图廊列表 —— 带原始文件名,否则设置页上只剩一串 hex,主人认不出哪个是哪个。
	app.get("/fonts", async (c) => {
		const fonts = await listFontAssets(deps.runtime.dataRoot);
		return c.json(ok({ fonts }) satisfies LibraryFontsResponse);
	});

	// 字体文件服务 —— 经 id 正则校验的定向读取(绝不 serveStatic 整个 dataRoot,内有 secrets)。
	// 返回原始字体字节;字体选择器当前仅消费列表,渲染期仍走内部读取器。
	app.get("/fonts/:id", async (c) => {
		const id = c.req.param("id");
		const res = await readFontAsset(deps.runtime.dataRoot, id);
		if (!res) return respondFailure(c, fail("not_found", t("cards.asset.fontNotFound")));
		const name =
			c.req.query("download") === "1"
				? ((await listFontAssets(deps.runtime.dataRoot)).find((entry) => entry.id === id)?.name ??
					id)
				: null;
		return new Response(res.bytes, {
			headers: {
				"Content-Type": res.mime,
				...(name
					? {
							"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(Buffer.from(name).toString("utf8"))}`,
						}
					: {}),
				"Cache-Control": "private, max-age=31536000, immutable",
			},
		});
	});

	// 字体删除 —— 仍被某处选着的先拦截(`conflict`,409)。直接删掉的话那一处立刻成了悬空引用:
	// 出图静静回落到兜底字体,而设置页上还显示着这款字体的名字,主人查都没法查。
	// 用家写进 `message`;删一款本来就不在的算删好了(幂等,同背景图)。
	app.delete("/fonts/:id", async (c) => {
		const id = c.req.param("id");
		if (!isValidFontAssetId(id))
			return respondFailure(c, fail("invalid", t("cards.asset.invalidId")));
		const referencedBy = fontAssetReferences(
			deps.store.getGlobals(),
			deps.store.getSubscriptions(),
			id,
			subscriptionLabelOf,
		);
		if (referencedBy.length > 0) {
			return respondFailure(
				c,
				fail("conflict", t("cards.asset.fontInUse", { users: describeUsers(referencedBy) })),
			);
		}
		await deleteFontAsset(deps.runtime.dataRoot, id);
		return c.json(ok());
	});

	return app;
}
