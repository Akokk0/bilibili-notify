import type { Context } from "koishi";
import { BilibiliNotifyAI } from "./ai-service";
import { type BilibiliNotifyAIConfig, BilibiliNotifyAIConfigSchema } from "./config";

export type { BilibiliNotifyAIConfig };
export { BilibiliNotifyAI };

export const name = "bilibili-notify-ai";

export const inject = {
	required: ["bilibili-notify"],
};

export type Config = BilibiliNotifyAIConfig;
export const Config = BilibiliNotifyAIConfigSchema;

export function apply(ctx: Context, config: Config): void {
	ctx.plugin(BilibiliNotifyAI, config);
}
