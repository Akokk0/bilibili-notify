import type { Context } from "koishi";
import { type BilibiliNotifyDynamicConfig, BilibiliNotifyDynamicSchema } from "./config";
import { BilibiliNotifyDynamic } from "./dynamic-service";
import type { DynamicFilterConfig } from "./types";

export type { DynamicFilterConfig };
export { BilibiliNotifyDynamic };

export const name = "bilibili-notify-dynamic";

export const inject = {
	required: ["bilibili-notify"],
	optional: ["bilibili-notify-image", "bilibili-notify-ai"],
};

export type Config = BilibiliNotifyDynamicConfig;
export const Config = BilibiliNotifyDynamicSchema;

export function apply(ctx: Context, config: Config): void {
	ctx.plugin(BilibiliNotifyDynamic, config);
}
