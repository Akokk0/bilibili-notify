/**
 * **草稿清单 → 一整份 HTML**。编辑器的实时预览(`POST /api/card-skins/:id/preview`)与
 * 「最终效果」截图(`POST /api/cards/skin-shot`)共用这一步。
 *
 * 共用不是为了省几行:两边**必须同源**。各走各的话,作者会看着一个能用的预览、截出一张
 * 不一样的图,而两边都说不出哪儿错了 —— 与「草稿走的是与保存同一道装包门」同一条道理,
 * 只是这回对齐的是预览与截图。
 *
 * 走的是装包门那一整套(验 + 洗),所以预览显示的是「存下去之后长什么样」;削掉了什么跟着
 * `warnings` 一起回,作者边编边看得见。
 */

import {
	cardOfManifest,
	renderCardWithSkin,
	sampleCardProps,
	skinAssetRefs,
} from "@bilibili-notify/image";
import { type CardSkinKind, resolvePreviewScene } from "@bilibili-notify/internal";
import { readCardSkinAssetDataUrl } from "./asset-url.js";
import { checkCardSkinPackage } from "./package.js";
import type { CardSkinStore } from "./store.js";

export type SkinPreviewHtml =
	| { ok: true; html: string; width: number; warnings: string[]; scene: string }
	| { ok: false; errors: string[] };

export async function renderSkinPreviewHtml(args: {
	store: CardSkinStore;
	/** 资产(图 / 字体)仍住在**已存盘**那套皮肤的目录里 —— 草稿只带清单,引用的是名字。 */
	skinId: string;
	kind: CardSkinKind;
	scene?: string;
	manifest: unknown;
}): Promise<SkinPreviewHtml> {
	const { store, skinId, kind } = args;
	const checked = checkCardSkinPackage(args.manifest, new Set(await store.listAssets(skinId)));
	if (!checked.ok) return { ok: false, errors: checked.errors };
	const manifest = checked.manifest;

	const card = cardOfManifest(manifest, kind);
	// 渲染器那头的 `resolveAsset` 是**同步**的(替换发生在字符串替换的回调里),所以
	// 先按引用名单把资产预取成表 —— 与出图那条路同一套路。
	const assets = new Map<string, string>();
	await Promise.all(
		skinAssetRefs(card, manifest.fonts).map(async (name) => {
			const url = await readCardSkinAssetDataUrl(store, skinId, name);
			if (url) assets.set(name, url);
		}),
	);

	const picked = resolvePreviewScene(kind, args.scene);
	// 刻意**不掺用户自己的配置**(全局字体 / 旋钮):编辑器看的是**这套皮肤**长什么样,
	// 掺进去就成了「同一套皮肤在不同人眼里不一样」,作者照着调反而调歪。
	const html = await renderCardWithSkin(
		kind,
		(await sampleCardProps(kind, picked.id)) as never,
		manifest,
		{ title: `皮肤预览 · ${kind}`, resolveAsset: (name) => assets.get(name) },
	);
	return { ok: true, html, width: card.width, warnings: checked.warnings, scene: picked.id };
}
