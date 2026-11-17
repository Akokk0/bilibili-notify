import type { DestinationStatus } from "@bilibili-notify/internal";

type Role = DestinationStatus["role"];

/** 只缓存上游角色；用量每次另读，发送成功后无需等待角色缓存过期。 */
export function createGroupRoleCache(
	limitedReason: () => string,
	limit = Number.POSITIVE_INFINITY,
) {
	const entries = new Map<string, { until: number; pending: boolean; result: Promise<Role> }>();
	const attempts = new Map<string, number[]>();
	return {
		clear() {
			entries.clear();
			attempts.clear();
		},
		read(
			key: string,
			budgetKey: string,
			load: () => Promise<Role>,
			refresh = false,
		): Promise<Role> {
			const now = Date.now();
			const old = entries.get(key);
			if (old && (old.pending || (!refresh && old.until > now))) return old.result;
			if (Number.isFinite(limit)) {
				const recent = (attempts.get(budgetKey) ?? []).filter((at) => now - at < 60_000);
				if (recent.length >= limit)
					return Promise.resolve({ state: "unknown", reason: limitedReason() });
				attempts.set(budgetKey, [...recent, now]);
			}
			const entry = {
				until: now + 60_000,
				pending: true,
				result: Promise.resolve<Role>({ state: "unknown" }),
			};
			entry.result = Promise.resolve()
				.then(load)
				.finally(() => {
					entry.pending = false;
				});
			entries.delete(key);
			entries.set(key, entry);
			while (entries.size > 256) entries.delete(entries.keys().next().value as string);
			while (attempts.size > 256) attempts.delete(attempts.keys().next().value as string);
			return entry.result;
		},
	};
}
