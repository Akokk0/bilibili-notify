import type { Context } from "koishi";
import { applyAdvancedSub, BilibiliNotifyAdvancedSubConfig } from "./core";

export const name = "bilibili-notify-advanced-subscription";

export type Config = BilibiliNotifyAdvancedSubConfig;
export const Config = BilibiliNotifyAdvancedSubConfig;

export function apply(ctx: Context, config: Config): void {
	applyAdvancedSub(ctx, config);
}
