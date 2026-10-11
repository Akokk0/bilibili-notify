import { describe, expect, it } from "vite-plus/test";
import { type AuthState, isLoggedIn } from "../auth-state";

/** `isLoggedIn`:六种状态逐个钉。`confirming`(两种情况)和 `expired` 都不算登录。 */
describe("isLoggedIn", () => {
	const rows: Array<[string, AuthState, boolean]> = [
		["logged-out", { status: "logged-out" }, false],
		[
			"awaiting-scan",
			{ status: "awaiting-scan", qr: { dataUrl: "data:image/png;base64,AA", expiresAt: "t" } },
			false,
		],
		[
			"confirming(已扫等手机确认)",
			{ status: "confirming", message: "已扫码，请在手机上确认" },
			false,
		],
		["confirming(开机没确认)", { status: "confirming" }, false],
		["logged-in", { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" }, true],
		["expired", { status: "expired", message: "登录失效" }, false],
		["error", { status: "error", message: "二维码已超时" }, false],
	];
	it.each(rows)("%s → %s", (_name, state, expected) => {
		expect(isLoggedIn(state)).toBe(expected);
	});
});
