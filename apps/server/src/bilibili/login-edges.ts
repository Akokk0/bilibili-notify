import type { Disposable, SourceAuth } from "@bilibili-notify/internal";

/**
 * 把一个登录口的原始状态变化收成「掉线」与「恢复」两条边。
 *
 * 扫码中、确认中、扫码出错都不算掉线;只有 `expired` / `logged-out` 才算。
 * 订阅时不是已登录就当作可能等待恢复,所以开机从 `confirming` 恢复也会通知一次。
 */
export function watchLoginEdges(
	auth: Pick<SourceAuth, "state" | "onChange">,
	{
		onLost,
		onRestored,
	}: {
		onLost: () => void;
		onRestored: () => void;
	},
): Disposable {
	let wasLoggedIn = auth.state().status === "logged-in";
	let needsRestore = !wasLoggedIn;
	const subscription = auth.onChange(() => {
		const status = auth.state().status;
		if (status === "expired" || status === "logged-out") {
			needsRestore = true;
			if (wasLoggedIn) onLost();
		} else if (status === "logged-in") {
			if (!wasLoggedIn && needsRestore) {
				needsRestore = false;
				onRestored();
			}
		}
		wasLoggedIn = status === "logged-in";
	});

	return {
		dispose() {
			subscription.dispose();
		},
	};
}
