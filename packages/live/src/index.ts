import type { Context } from "koishi";
import { BilibiliNotifyLiveConfig } from "./config";
import { BilibiliNotifyLive } from "./live-service";

export { BilibiliNotifyLive };

export const name = "bilibili-notify-live";

export const inject = {
	required: ["bilibili-notify"],
	optional: ["bilibili-notify-image", "bilibili-notify-ai"],
};

export type Config = BilibiliNotifyLiveConfig;
export const Config = BilibiliNotifyLiveConfig;

export function apply(ctx: Context, config: Config): void {
	ctx.plugin(BilibiliNotifyLive, config);
}
