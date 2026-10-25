import type { Disposable, SourceAuth } from "@bilibili-notify/internal";

/**
 * 把一个登录口的原始状态变化收成「掉线」与「恢复」两条边。
 *
 * 扫码中、确认中、扫码出错都不算掉线;只有 `expired` / `logged-out` 才算。
 * 订阅时不是已登录就当作可能等待恢复,所以开机从 `confirming` 恢复也会通知一次。
 *
 * `needsRestore` 故意不以「先登录过」为前提:引擎撞上 -101 会自己停下等登录恢复,而冷启动时 cookie 已过期,
 * 登录流走的是 checking → logged-out,从没有过「已登录」这一帧,也就没有掉线这条边。要是只在掉过线之后才记
 * 「待恢复」,主人重新扫码登上之后那些引擎会一直停着。代价是第一次登录之后多一次恢复:各引擎都按当前名单
 * 重新播种(重启检测、重建监听),多一次是白干活,不是坏数据。
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
