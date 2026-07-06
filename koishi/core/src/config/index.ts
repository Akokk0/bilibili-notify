import { Schema } from "koishi";
import { type AccountConfig, AccountConfigSchema } from "./account";
import { type AIConfig, AIConfigSchema } from "./ai";
import { type DynamicConfig, DynamicConfigSchema } from "./dynamic";
import { type LiveConfig, LiveConfigSchema } from "./live";
import { type PushConfig, PushConfigSchema } from "./push";
import { type RenderConfig, RenderConfigSchema } from "./render";
import { type SubscriptionsConfig, SubscriptionsConfigSchema } from "./subscriptions";

export type { AccountConfig } from "./account";
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
	/**
	 * 高级订阅总开关。TODO(切片 8):吸收 advanced-subscription 卫星包后并入
	 * advancedSub 域(连同 advancedSub.subs 字典),此字段届时删除。
	 */
	advancedSub: boolean;
}

export const BilibiliNotifyConfigSchema: Schema<BilibiliNotifyConfig> = Schema.object({
	account: AccountConfigSchema,
	push: PushConfigSchema,
	subscriptions: SubscriptionsConfigSchema,
	render: RenderConfigSchema,
	ai: AIConfigSchema,
	dynamic: DynamicConfigSchema,
	live: LiveConfigSchema,
	advancedSub: Schema.boolean()
		.default(false)
		.description(
			"这个开关决定是否使用高级订阅功能喔～如果主人想要超级灵活的订阅内容，就请开启呀 (๑•̀ㅂ•́)و♡",
		),
});
