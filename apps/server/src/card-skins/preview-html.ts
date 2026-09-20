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

import { cardOfManifest, renderCardWithSkin, sampleCard } from "@bilibili-notify/image";
import { type CardSkinKind, resolvePreviewScene } from "@bilibili-notify/internal";
import { prefetchCardSkinAssets } from "./asset-url.js";
import { checkCardSkinPackage } from "./package.js";
import type { CardSkinStore } from "./store.js";

export type SkinPreviewHtml =
	| {
			ok: true;
			html: string;
			width: number;
			bleed: number;
			warnings: string[];
			scene: string;
	  }
	| { ok: false; errors: string[] };

export async function renderSkinPreviewHtml(args: {
	store: CardSkinStore;
	/** 资产(图 / 字体)仍住在**已存盘**那套皮肤的目录里 —— 草稿只带清单,引用的是名字。 */
	skinId: string;
	kind: CardSkinKind;
	scene?: string;
	manifest: unknown;
	/**
	 * 把这份 HTML 按**塞进 iframe 看**来收拾(编辑器的实时预览、聊天里的卡片预览):
	 * **页面底透明**。面板量文档根的高度来定框高,量到了框与卡一样高;万一量不到,框退回
	 * 固定视口,卡比它矮时下面露出来的那片默认白底**不属于这张卡**(真出图按卡的
	 * boundingBox 裁,那片底根本不进图)。透明之后,框里卡外那一圈就是框自己的底。
	 *
	 * ⛔ **别给文档根加 `min-height:100vh`**(从前为了在固定视口里垂直居中加过):面板量的
	 * 就是文档根,撑到视口高之后量到的是「卡高与视口取大」,短卡的框永远缩不回去。
	 *
	 * ⛔ 截图那条**不能**开:截出来是 JPEG,没有 alpha,透明会被压成黑 —— 圆角外会多一圈
	 * 黑边,而「最终效果」这颗按钮的全部意义就是像素级可信。
	 */
	transparentPage?: boolean;
}): Promise<SkinPreviewHtml> {
	const { store, skinId, kind } = args;
	const checked = checkCardSkinPackage(args.manifest, new Set(await store.listAssets(skinId)));
	if (!checked.ok) return { ok: false, errors: checked.errors };
	const manifest = checked.manifest;

	const card = cardOfManifest(manifest, kind);
	const assets = await prefetchCardSkinAssets(store, skinId, manifest, kind);

	const picked = resolvePreviewScene(kind, args.scene);
	// 刻意**不掺用户自己的配置**(全局字体 / 旋钮):编辑器看的是**这套皮肤**长什么样,
	// 掺进去就成了「同一套皮肤在不同人眼里不一样」,作者照着调反而调歪。
	// `raw` 只有动态卡有(视频卡 / 图廊那两组契约字段从它取),别的卡种是 undefined ——
	// 原样递进去,渲染器自己认。
	const sample = await sampleCard(kind, picked.id);
	const html = await renderCardWithSkin(kind, sample.props as never, manifest, {
		title: `皮肤预览 · ${kind}`,
		resolveAsset: (name) => assets.get(name),
		...(sample.raw ? { raw: sample.raw } : {}),
	});
	return {
		ok: true,
		html: args.transparentPage ? withPreviewPageCss(html) : html,
		// **整张图**的宽,不是卡宽 —— 写了出血的皮肤,图比卡宽两道出血。面板拿这个数
		// 定 iframe / 截图的宽度,给卡宽的话出血那圈会在编辑器里被切掉,而出血存在的
		// 全部意义就是让辉光在成品里看得见。
		width: card.width + (card.bleed?.size ?? 0) * 2,
		/** 这张卡的出血 px(每边)。调用方判「超高」时要把上下两道减掉。 */
		bleed: card.bleed?.size ?? 0,
		warnings: checked.warnings,
		scene: picked.id,
	};
}

/**
 * 按「塞进 iframe 看」收拾这份 HTML:配色方案、透明底。插在 `<body>` **之前**、
 * 也就是外壳那段 `<style>` 之后 —— 皮肤自己的 CSS 只作用在卡片根往里,够不到 `html` /
 * `body`,所以这几句不会跟任何皮肤打架。
 *
 * **`color-scheme` 是这里最要紧的一句,少了它透明那句白写。** Chrome 的规矩:一份文档的
 * used color-scheme 与**父文档**不同时,UA 必须给它画一个**不透明**的 canvas。面板开着
 * 暗色主题(`:root{color-scheme:dark}`),而这份 HTML 什么都没声明 = light,于是 Chrome
 * 直接铺一层白 —— `background:transparent` 照样生效(computed 就是 `rgba(0,0,0,0)`),
 * 画面上还是白。声明「两种都支持」之后 used color-scheme 跟着父走,canvas 才真透明。
 *
 * 跟着补一句 `color:#000`:开了 `light dark` 之后,**没写颜色**的元素(自定义块里可能有)
 * 在暗色下会被 UA 翻成白字,而截图那条走的是 light、UA 默认黑字 —— 两边就分家了。把继承
 * 起点钉死成 light 那一档,块自己写的颜色照旧压过它。
 */
function withPreviewPageCss(html: string): string {
	return html.replace(
		"<body>",
		"<style>:root{color-scheme:light dark}" +
			"html,body{background:transparent !important;color:#000}</style><body>",
	);
}
