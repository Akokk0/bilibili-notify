import { Schema } from "koishi";
import { type AccountConfig, AccountConfigSchema } from "./account";
import { type AdvancedSubConfig, AdvancedSubConfigSchema } from "./advanced-sub";
import { type AIConfig, AIConfigSchema } from "./ai";
import { type DynamicConfig, DynamicConfigSchema } from "./dynamic";
import { type LiveConfig, LiveConfigSchema } from "./live";
import { type PushConfig, PushConfigSchema } from "./push";
import { type RenderConfig, RenderConfigSchema } from "./render";
import { type SubscriptionsConfig, SubscriptionsConfigSchema } from "./subscriptions";

export type { AccountConfig } from "./account";
export type { AdvancedSubConfig } from "./advanced-sub";
export type { AIConfig, PersonaConfig } from "./ai";
export type { DynamicConfig } from "./dynamic";
export type { LiveConfig } from "./live";
export type { MasterConfig, PushConfig, QuietHourRange } from "./push";
export type { RenderConfig } from "./render";
export type { FlatSubConfigItem, SubscriptionsConfig } from "./subscriptions";

export interface BilibiliNotifyConfig {
	account: AccountConfig;
	push: PushConfig;
	subscriptions: SubscriptionsConfig;
	render: RenderConfig;
	ai: AIConfig;
	dynamic: DynamicConfig;
	live: LiveConfig;
	advancedSub: AdvancedSubConfig;
}

export const BilibiliNotifyConfigSchema: Schema<BilibiliNotifyConfig> = Schema.object({
	account: AccountConfigSchema,
	push: PushConfigSchema,
	subscriptions: SubscriptionsConfigSchema,
	render: RenderConfigSchema,
	ai: AIConfigSchema,
	dynamic: DynamicConfigSchema,
	live: LiveConfigSchema,
	advancedSub: AdvancedSubConfigSchema,
});
