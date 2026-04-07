import BilibiliNotifyImage from "./image-service";

export type { CardColorOptions, Dynamic, LiveData, RichTextNode } from "./types";
export type { BilibiliNotifyImage as BilibiliNotifyImageType };
export { BilibiliNotifyImage };

export const name = "bilibili-notify-image";
export type Config = BilibiliNotifyImage.Config;
export const Config = BilibiliNotifyImage.Config;

export function apply(ctx: import("koishi").Context, config: Config) {
	ctx.plugin(BilibiliNotifyImage, config);
}
