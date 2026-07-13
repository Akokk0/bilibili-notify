import { Schema } from "koishi";
import { type AccountConfig, AccountConfigSchema } from "./account";
import { type AdvancedSubConfig, AdvancedSubConfigSchema } from "./advanced-sub";
import { type AIConfig, AIConfigSchema } from "./ai";
import { type DynamicConfig, DynamicConfigSchema } from "./dynamic";
import { type LiveConfig, LiveConfigSchema } from "./live";
import { type PushConfig, PushConfigSchema } from "./push";
import { type RenderConfig, RenderConfigSchema } from "./render";
import { type SubscriptionsConfig, SubscriptionsConfigSchema } from "./subscriptions";

export interface BilibiliNotifyConfig {
	account: AccountConfig;
	push: PushConfig;
	subscriptions: SubscriptionsConfig;
	advancedSub: AdvancedSubConfig;
	render: RenderConfig;
	ai: AIConfig;
	dynamic: DynamicConfig;
	live: LiveConfig;
}

export const BilibiliNotifyConfigSchema: Schema<BilibiliNotifyConfig> = Schema.object({
	account: AccountConfigSchema,
	push: PushConfigSchema,
	subscriptions: SubscriptionsConfigSchema,
	advancedSub: AdvancedSubConfigSchema,
	render: RenderConfigSchema,
	ai: AIConfigSchema,
	dynamic: DynamicConfigSchema,
	live: LiveConfigSchema,
});
