export type { Component, VNode } from "vue";
// Re-export vue's h so consumers (e.g. apps/server's preview route
// that needs to construct VNodes for a DynamicNode's body/additional) link
// against THIS package's vue copy. Without it a second vue install in the
// consumer's tree creates mismatched VNode / Component types — TS rejects the
// argument because the two `Component` types are unrelated nominally.
export { h } from "vue";
// 块库:每种卡一张表,键名对齐 `CARD_SKIN_BUILTIN_BLOCKS`(ADR-0014 的卡片皮肤按块装配)。
export { DYNAMIC_BLOCKS, type DynamicBlockProps } from "./blocks/dynamic";
// 卡片外框(根块):皮肤渲染器给每张卡套的那两层壳。
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
// 直播卡的中立输入 → 块与皮肤契约吃的视图(ADR-0019 决策 68)。绕开 ImageRenderer 自己拼
// `renderCardWithSkin` 入参的调用方(预览路由)用它,与推送出图排出同一份。
export { buildLiveCardView } from "./live-view";
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
	readCardField,
} from "./skin/card-data";
// 字体 / 图两档旋钮的**宿主解析**(ADR-0014 决策 16 的 🔗):这两档的值是主人资产库里的
// 一个 id,要 await 读盘才变得成 CSS,所以 `cardSkinKnobCss` 那条同步路径上做不了。
// **凡是自己拼 `renderCardWithSkin` 入参的调用方都得调它** —— 只传 `knobValues` 的话,
// 别的旋钮照常生效,而字体与背景图这两枚静静地什么也不做(2026-09-19 面板预览栽过)。
export {
	CSS_CUSTOM_PROPERTY_MAX_CHARS,
	IMAGE_URL_BUDGET,
	type KnobAssetResolvers,
	type ResolvedKnobAssets,
	resolveKnobAssets,
} from "./skin/knob-assets";
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
// 超上限的图压进预算 —— 用 Chrome 自己当编码器,不引新依赖。凡是自己拼
// `resolveKnobAssets` 入参的调用方都该把它接上,否则大图照旧静默不出。
export { shrinkImageForCssVar } from "./skin/shrink-image";
// 七种卡的 **props 契约**。整卡模板已退役(ADR-0014 决策 24 的 2026-09-18 🔗) ——
// 出图一律走 `renderCardWithSkin`,这里只剩「一张卡要哪些数据」这层类型。
export type { DynamicCardProps, DynamicNode } from "./templates/dynamic-card";
// 造动态卡 node 的零件(ADR-0019 决策 68):拓展作品照着 B 站那条同样造一棵 node,交给
// `ImageRenderer.generateNeutralDynamicCard`。图廊与纯文本正文与 B 站那条同一份实现。
export {
	buildGallery,
	buildPlainText,
	type DynamicVideo,
	type GalleryImage,
} from "./templates/dynamic-content";
export type { GuardCardProps } from "./templates/guard-card";
// 直播卡(ADR-0019 决策 68):中立的输入交给 `ImageRenderer.generateNeutralLiveCard`;
// 视图是块与皮肤契约吃的那一份(`buildLiveCardView` 从输入排出来)。`LiveCardProps` 是 🪦 旧形状。
export type {
	LiveCardInput,
	LiveCardProps,
	LiveCardStatus,
	LiveCardView,
} from "./templates/live-card";
export type {
	RoastBoardCardProps,
	RoastCardUp,
	RoastSoloCardProps,
} from "./templates/roast-card";
export type { SCCardProps } from "./templates/sc-card";
export type {
	CardColorOptions,
	Dynamic,
	LiveData,
	RichTextNode,
} from "./types";
