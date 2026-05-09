export type { Component, VNode } from "vue";
// Re-export vue's h so consumers (e.g. apps/server's preview route
// that needs to construct a VNode for DynamicCardProps.mainContent) link
// against THIS package's vue copy. Without it a second vue install in the
// consumer's tree creates mismatched VNode / Component types — TS rejects the
// argument because the two `Component` types are unrelated nominally.
export { h } from "vue";
export {
	ImageRenderer,
	type ImageRendererConfig,
	type ImageRendererOptions,
} from "./image-renderer";
export type {
	BoundingBox,
	ElementHandleLike,
	PageLike,
	PuppeteerLike,
	ScreenshotClip,
	ScreenshotOptions,
	SetContentOptions,
	WaitForFunctionOptions,
} from "./puppeteer";
export { renderCard } from "./render";
export { DynamicCard, type DynamicCardProps } from "./templates/dynamic-card";
export { GuardCard, type GuardCardProps } from "./templates/guard-card";
export { LiveCard, type LiveCardProps } from "./templates/live-card";
export { SCCard, type SCCardProps } from "./templates/sc-card";
export type {
	CardColorOptions,
	Dynamic,
	LiveData,
	RichTextNode,
} from "./types";
