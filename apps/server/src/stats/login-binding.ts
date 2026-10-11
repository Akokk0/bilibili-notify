import { isLoggedIn, type SourceAuth } from "@bilibili-notify/internal";
import type { StatsRecorderHandle } from "./recorder.js";

/**
 * 入口把统计的「来源在跑」读口接到登录口上:读口每次现读 `auth.state()`,只有 `logged-in` 算登录
 * (`confirming` —— 开机还没确认上、或已扫等手机确认 —— 不算,统计不记「在跑」)。
 * 抽成函数是为了让这一行接线能被测试钉住(`index.ts` 里整个装配起不到真的登录态)。
 */
export function bindStatsLoginState(
	recorder: Pick<StatsRecorderHandle, "bindLoginState">,
	auth: Pick<SourceAuth, "state">,
): void {
	recorder.bindLoginState(() => isLoggedIn(auth.state()));
}
