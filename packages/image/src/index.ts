export type { Component, VNode } from "vue";
// Re-export vue's h so consumers (e.g. apps/server's preview route
// that needs to construct VNodes for a DynamicNode's body/additional) link
// against THIS package's vue copy. Without it a second vue install in the
// consumer's tree creates mismatched VNode / Component types — TS rejects the
// argument because the two `Component` types are unrelated nominally.
export { h } from "vue";
// 块库:每种卡一张表,键名对齐 `CARD_SKIN_BUILTIN_BLOCKS`(ADR-0014 的卡片皮肤按块装配)。
// 转发框那层 div 的 class —— 它是原子块自己的根,挂点是 self,认框只能认 class。
export { DYNAMIC_BLOCKS, type DynamicBlockProps, FORWARD_INSET_CLASS } from "./blocks/dynamic";
// 卡片外框(根块):模板路径与皮肤路径共用的那两层壳。
export {
	type CardPropsByKind,
	FRAMES,
	type FrameExtra,
	type FrameRenderer,
} from "./blocks/frames";
export { GUARD_BLOCKS } from "./blocks/guard";
export { LIVE_BLOCKS } from "./blocks/live";
export { ROAST_BOARD_BLOCKS, ROAST_SOLO_BLOCKS } from "./blocks/roast";
export { SC_BLOCKS } from "./blocks/sc";
export type { BlockRenderer } from "./blocks/types";
export { WORDCLOUD_BLOCKS } from "./blocks/wordcloud";
export { numberToStr } from "./format";
export {
	ImageRenderer,
	type ImageRendererConfig,
	type ImageRendererOptions,
	type RoastBoardData,
	type RoastSoloData,
} from "./image-renderer";
// 出厂示例卡片数据 —— 皮肤编辑器的实时预览拿它当「假数据」出图(ADR-0014 决策 22)。
// 刻意回 `unknown`:示例数据不是对外契约,别让调用方照它的形状写类型。
export { sampleCard } from "./preview/sample-cards";
export type {
	BoundingBox,
	ElementHandleLike,
	PageLike,
	PageOptions,
	PuppeteerLike,
	RenderPriority,
	ScreenshotClip,
	ScreenshotOptions,
	SetContentOptions,
	WaitForFunctionOptions,
} from "./puppeteer";
// `buildFontFace` / `USER_FONT_FAMILY` 给绕开 ImageRenderer 直接调 renderCard 的那条
// 预览路径用 —— 两边必须拼出同一条 @font-face,否则「预览是这款、推出去是另一款」。
export { buildFontFace, renderCard, USER_FONT_FAMILY } from "./render";
// 卡片皮肤的对外数据契约(ADR-0014 决策 14):内部 props → `CARD_SKIN_FIELDS` 那张表。
export {
	buildCardData,
	type CardData,
	type CardDataValue,
	cardVariantForProps,
	readCardField,
} from "./skin/card-data";
// 皮肤渲染器(ADR-0014 决策 18):皮肤 JSON + props → VNode / 完整 HTML。
// **出图的主入口是 `renderCardWithSkin`** —— 推送(ImageRenderer)与面板预览共用它。
export {
	BLOCKED_IMG_PLACEHOLDER,
	cardOfManifest,
	renderCardWithSkin,
	renderSkinnedCard,
	type SkinCardHtmlOptions,
	type SkinRenderOptions,
	type SkinRenderResult,
	skinAssetRefs,
} from "./skin/render-skin";
// 四种可编辑卡的 **props 契约**。整卡模板已退役(ADR-0014 决策 24 的 2026-09-18 🔗) ——
// 出图一律走 `renderCardWithSkin`,这里只剩「一张卡要哪些数据」这层类型。
export type { DynamicCardProps, DynamicNode } from "./templates/dynamic-card";
export type { GuardCardProps } from "./templates/guard-card";
export type { LiveCardProps } from "./templates/live-card";
export {
	RoastBoardCard,
	type RoastBoardCardProps,
	type RoastCardUp,
	RoastSoloCard,
	type RoastSoloCardProps,
} from "./templates/roast-card";
export type { SCCardProps } from "./templates/sc-card";
export type {
	CardColorOptions,
	Dynamic,
	LiveData,
	RichTextNode,
} from "./types";
