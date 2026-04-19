import type { SubItem } from "@bilibili-notify/push";

export type SubscriptionOp =
	| { type: "add"; sub: SubItem }
	| { type: "delete"; sub: SubItem }
	| { type: "update"; prev: SubItem; next: SubItem };
