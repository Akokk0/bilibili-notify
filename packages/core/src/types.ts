import type { SubItem } from "@bilibili-notify/push";

/** A scoped change object — each variant only carries fields relevant to its scope. */
export type LiveSubChange = { scope: "live" } & Partial<
	Pick<
		SubItem,
		| "live"
		| "liveAtAll"
		| "liveEnd"
		| "liveGuardBuy"
		| "superchat"
		| "wordcloud"
		| "liveSummary"
		| "uname"
		| "roomId"
		| "customCardStyle"
		| "customLiveMsg"
		| "customGuardBuy"
		| "customLiveSummary"
		| "customSpecialDanmakuUsers"
		| "customSpecialUsersEnterTheRoom"
		| "specialUsers"
	>
>;
export type DynamicSubChange = { scope: "dynamic" } & Partial<
	Pick<SubItem, "dynamic" | "dynamicAtAll">
>;
export type TargetSubChange = { scope: "target" } & Pick<SubItem, "target">;
export type SubChange = LiveSubChange | DynamicSubChange | TargetSubChange;

export type SubscriptionOp =
	| { type: "add"; sub: SubItem }
	| { type: "delete"; uid: string }
	| { type: "update"; uid: string; changes: SubChange[] };
