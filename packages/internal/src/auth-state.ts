/**
 * 登录 / 扫码建连接的中立状态。状态值 kebab;订阅侧的 `SourceAuth` 与推送侧的
 * `connectionAuth` 共用这一份。
 *
 * - `awaiting-scan.qr.dataUrl`:`data:image/…;base64,…` 的整串,面板直接画。
 * - `awaiting-scan.qr.expiresAt`:ISO 字符串,**最晚作废时刻**。给不出真过期时刻的平台取
 *   「创建时刻 + 清扫时限」,所以它是上界,不是平台二维码真正的过期时刻。
 * - `error` / `expired` 的 `message` 由服务端给人话,面板只显示。
 */
export type AuthState =
	| { status: "logged-out" }
	| { status: "awaiting-scan"; qr: { dataUrl: string; expiresAt: string } }
	| { status: "scanned" }
	| { status: "logged-in"; loggedInAt: string }
	| { status: "expired" | "error"; message: string };
