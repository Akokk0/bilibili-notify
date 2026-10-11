/**
 * 登录 / 扫码建连接的中立状态。状态值 kebab;订阅侧的 `SourceAuth` 与推送侧的
 * `connectionAuth` 共用这一份,取值是两边的并集。
 *
 * - `logged-out`:没登录。
 * - `awaiting-scan`:等扫码。`qr.dataUrl` 是 `data:image/…;base64,…` 的整串,面板直接画;
 *   `qr.expiresAt` 是 ISO 字符串,**最晚作废时刻**。给不出真过期时刻的平台取
 *   「创建时刻 + 清扫时限」,所以它是上界,不是平台二维码真正的过期时刻。
 * - `confirming`:**BN 还在等 / 还在核,此刻不算登录**。是 BN 推断的状态,不是平台报的。
 *   两种情况都用它:手机上已扫、等主人在手机上点确认;手里有登录信息、还没向平台确认有效。
 *   `message` 由服务端给人话(两种情况要主人做的事不同,读的人分不出来);没有 `message`
 *   时读的人写「正在确认」。`connectionAuth` 没有产出者(QQ 没有「已扫、等确认」)。
 * - `logged-in`:`loggedInAt` 是这个进程里这一段登录第一次被确认的时刻(不落盘)。
 * - `expired`:**已经登着的登录失效了,要重新登录**。只有订阅侧会发;`connectionAuth`
 *   没有「已经登着的登录」,不发它。
 * - `error`:这一次没办成,`message` 说原因。**二维码超时、失效两边都报它**。
 *
 * `error` / `expired` 的 `message` 由服务端给人话,面板只显示,不靠比对文字做判断。
 */
export type AuthState =
	| { status: "logged-out" }
	| { status: "awaiting-scan"; qr: { dataUrl: string; expiresAt: string } }
	| { status: "confirming"; message?: string }
	| { status: "logged-in"; loggedInAt: string }
	| { status: "expired" | "error"; message: string };

/**
 * 这个状态算不算「已登录」。只有 `logged-in` 算:`confirming` 是「BN 还在等 / 还在核」,此刻不算登录。
 * 统计的「在跑」、开机补关注这类只认已登录的读者都用它,免得各写一遍、哪天有人把 `confirming` 也算进去而没人发现。
 */
export function isLoggedIn(state: AuthState): boolean {
	return state.status === "logged-in";
}
