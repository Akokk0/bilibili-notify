import { isDeepStrictEqual } from "node:util";
import type { SubItem } from "@bilibili-notify/push";
import type { SubChange, SubscriptionOp } from "./types";

const LIVE_MASTER_KEYS = [
	"live",
	"liveAtAll",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"wordcloud",
	"liveSummary",
] as const satisfies ReadonlyArray<keyof SubItem>;

const LIVE_CUSTOM_KEYS = [
	"customCardStyle",
	"customLiveMsg",
	"customGuardBuy",
	"customLiveSummary",
	"customSpecialDanmakuUsers",
	"customSpecialUsersEnterTheRoom",
	"specialUsers",
] as const satisfies ReadonlyArray<keyof SubItem>;

/** Diff two SubItem snapshots and return a typed SubChange array. */
export function diffSubItems(prev: SubItem, next: SubItem): SubChange[] {
	const result: SubChange[] = [];

	const liveChange: Record<string, unknown> = { scope: "live" };
	for (const key of LIVE_MASTER_KEYS) {
		if (prev[key] !== next[key]) liveChange[key] = next[key];
	}
	if (prev.uname !== next.uname) liveChange.uname = next.uname;
	if (prev.roomId !== next.roomId) liveChange.roomId = next.roomId;
	for (const key of LIVE_CUSTOM_KEYS) {
		if (!isDeepStrictEqual(prev[key], next[key])) liveChange[key] = next[key];
	}
	if (Object.keys(liveChange).length > 1) result.push(liveChange as SubChange);

	const dynamicChange: Record<string, unknown> = { scope: "dynamic" };
	if (prev.dynamic !== next.dynamic) dynamicChange.dynamic = next.dynamic;
	if (prev.dynamicAtAll !== next.dynamicAtAll) dynamicChange.dynamicAtAll = next.dynamicAtAll;
	if (Object.keys(dynamicChange).length > 1) result.push(dynamicChange as SubChange);

	if (!isDeepStrictEqual(prev.target, next.target))
		result.push({ scope: "target", target: next.target });

	return result;
}

/** Compute the SubscriptionOp[] resulting from replacing `prev` with `next`. */
export function diffSubManagers(
	prev: Map<string, SubItem>,
	next: Map<string, SubItem>,
): SubscriptionOp[] {
	const ops: SubscriptionOp[] = [];
	for (const [uid] of prev) {
		if (!next.has(uid)) ops.push({ type: "delete", uid });
	}
	for (const [uid, sub] of next) {
		const prevSub = prev.get(uid);
		if (!prevSub) {
			ops.push({ type: "add", sub });
		} else {
			const changes = diffSubItems(prevSub, sub);
			if (changes.length) ops.push({ type: "update", uid, changes });
		}
	}
	return ops;
}
