import type { AccountView } from "@bilibili-notify/contract";
import type { SourceView } from "../subscriptions/registry.js";

/** A fresh projection of registered login sources; never reads subscription profiles. */
export function accountViews(
	sources: readonly SourceView[],
	order: readonly string[] = [],
): AccountView[] {
	const accounts = sources.flatMap(({ sourceKey, auth }) => {
		if (!auth) return [];
		const state = auth.state();
		const account = auth.account?.();
		return [
			{
				sourceKey,
				state,
				...(account
					? {
							account: {
								name: account.name,
								...(account.avatar === undefined ? {} : { avatar: account.avatar }),
							},
						}
					: {}),
			},
		];
	});
	const remaining = new Map(accounts.map((account) => [account.sourceKey, account]));
	const sorted: AccountView[] = [];
	for (const key of order) {
		const account = remaining.get(key);
		if (!account) continue;
		sorted.push(account);
		remaining.delete(key);
	}
	return [...sorted, ...remaining.values()];
}
