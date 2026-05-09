import type { FeatureKey, PushTarget, Subscription, SubscriptionRouting } from "../../types/domain";

const PALETTE = [
	"#FF6699",
	"#00AEEC",
	"#FB7299",
	"#a29bfe",
	"#fdcb6e",
	"#74b9ff",
	"#22c55e",
	"#f2a053",
];

/** Stable per-UP color derived from uid; gives every UP a recognisable accent. */
export function colorFromUid(uid: string): string {
	let h = 0;
	for (let i = 0; i < uid.length; i++) {
		h = (h * 31 + uid.charCodeAt(i)) | 0;
	}
	return PALETTE[Math.abs(h) % PALETTE.length];
}

export function displayName(sub: Subscription): string {
	return sub.cachedProfile?.name?.trim() || `UID ${sub.uid}`;
}

export function activeFeatures(routing: SubscriptionRouting): FeatureKey[] {
	const keys = Object.keys(routing) as FeatureKey[];
	return keys.filter((k) => routing[k].length > 0);
}

/** Aggregate every target id referenced by routing. */
export function routedTargetIds(sub: Subscription): string[] {
	const out = new Set<string>();
	for (const arr of Object.values(sub.routing)) for (const id of arr) out.add(id);
	return [...out];
}

export function targetsById(targets: PushTarget[]): Map<string, PushTarget> {
	const m = new Map<string, PushTarget>();
	for (const t of targets) m.set(t.id, t);
	return m;
}

export function relativeTime(iso: string | undefined): string {
	if (!iso) return "—";
	const ts = new Date(iso).getTime();
	if (Number.isNaN(ts)) return "—";
	const delta = Date.now() - ts;
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	return `${Math.floor(delta / 86_400_000)} 天前`;
}
