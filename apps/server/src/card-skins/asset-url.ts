/**
 * 皮肤包内资产 → **可内联进卡片 HTML 的 data URL**。
 *
 * 出图这条路不能给浏览器一个 `http://…/api/card-skins/…` 的地址:截图页面是
 * `--no-sandbox` 的 puppeteer 用 `setContent` 灌进去的一团 HTML,里头**不许有任何外部
 * 引用**(`image-renderer.ts` 的 `inlineRemoteImages` 就是在守这条)。所以资产在进 HTML
 * 之前就得变成 data URL。
 *
 * mime 查的是站内那两张唯一的表(图片 `image-mime.ts`、字体 `font-mime.ts`)—— 查不到就
 * 不给(返回 undefined),渲染器那头换透明占位。宁可缺一张图,也别塞一个
 * `application/octet-stream` 的 data URL 进去:浏览器不会拿它当图画,而症状是「图没了」,
 * 和缺图一模一样却更难查。
 */

import { cardOfManifest, skinAssetRefs } from "@bilibili-notify/image";
import type { CardSkinKind, CardSkinManifest } from "@bilibili-notify/internal";
import { FONT_EXT_TO_MIME } from "../runtime/font-mime.js";
import { EXT_TO_MIME } from "../runtime/image-mime.js";
import type { CardSkinStore } from "./store.js";

export async function readCardSkinAssetDataUrl(
	store: Pick<CardSkinStore, "readAsset" | "ensureReady">,
	skinId: string,
	/** 包内名字,`assets/<名>` 形式(与清单里的引用同构)。 */
	name: string,
): Promise<string | undefined> {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	// 图片与字体各自的唯一表(皮肤自带字体走 `@font-face`,也得从这一口拿 data URL)。
	const mime = EXT_TO_MIME[ext] ?? FONT_EXT_TO_MIME[ext];
	if (!mime) return undefined;
	await store.ensureReady();
	const bytes = await store.readAsset(skinId, name);
	if (!bytes) return undefined;
	return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * 这张卡要用的**包内资产**预取成表。
 *
 * 渲染器那头的资产查表是**同步**的(替换发生在一次字符串替换的回调里),而读盘是异步的
 * —— 所以先按 `skinAssetRefs` 列出名单一次性取完,再把表交给渲染器。取不到的不进表
 * (渲染器那头用透明占位)。
 *
 * **服务端这两条路(编辑器预览 / 面板预览出图)共用这一份**:名单的口径哪天要变(比如多
 * 认一档引用),漏改一处的症状是「预览有图、推出去没有」,而两边代码看着都对。出图那条
 * 路在 `ImageRenderer#prefetchSkinAssets`,它读的是注入进来的 resolver,不走这里。
 */
export async function prefetchCardSkinAssets(
	store: Pick<CardSkinStore, "readAsset" | "ensureReady">,
	skinId: string,
	manifest: CardSkinManifest,
	kind: CardSkinKind,
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	await Promise.all(
		skinAssetRefs(cardOfManifest(manifest, kind), manifest.fonts).map(async (name) => {
			const url = await readCardSkinAssetDataUrl(store, skinId, name);
			if (url) out.set(name, url);
		}),
	);
	return out;
}
