export type { Component, VNode } from "vue";
// Re-export vue's h so consumers (e.g. apps/server's preview route
// that needs to construct VNodes for a DynamicNode's body/additional) link
// against THIS package's vue copy. Without it a second vue install in the
// consumer's tree creates mismatched VNode / Component types — TS rejects the
// argument because the two `Component` types are unrelated nominally.
export { h } from "vue";
// 块库:每种卡一张表,键名对齐 `CARD_SKIN_BUILTIN_BLOCKS`(ADR-0014 的卡片皮肤按块装配)。
export { DYNAMIC_BLOCKS, type DynamicBlockProps } from "./blocks/dynamic";
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
export { DynamicCard, type DynamicCardProps, type DynamicNode } from "./templates/dynamic-card";
export { GuardCard, type GuardCardProps } from "./templates/guard-card";
export { LiveCard, type LiveCardProps } from "./templates/live-card";
export {
	RoastBoardCard,
	type RoastBoardCardProps,
	type RoastCardUp,
	RoastSoloCard,
	type RoastSoloCardProps,
} from "./templates/roast-card";
export { SCCard, type SCCardProps } from "./templates/sc-card";
export type {
	CardColorOptions,
	Dynamic,
	LiveData,
	RichTextNode,
} from "./types";
