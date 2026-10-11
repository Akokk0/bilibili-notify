import type { AuthState } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import type { UserCardInfo } from "../../api/types.js";
import { authStateFromLoginState, type BiliLoginState } from "../login-state.js";

const CARD = { card: { mid: "42", name: "n", face: "https://i0.hdslb.com/a.jpg" } } as UserCardInfo;
const QR = "data:image/png;base64,AAAA";
const EXPIRES = "2026-10-11T00:03:00.000Z";
const SINCE = "2026-10-11T00:00:00.000Z";

/**
 * 内部原形 → 对外 `AuthState` 的全表(方案 3a-29 §3.3)。凡涉及 `confirming` 的格连 `message` 一起断言:
 * 它一个取值两种情况(开机没确认 / 已扫等手机确认),只断言 `status` 分不出走的是哪一种。
 */
describe("authStateFromLoginState — 全表", () => {
	const rows: Array<[string, BiliLoginState, AuthState]> = [
		[
			"checking → 正在确认(开机没确认)",
			{ status: "checking" },
			{ status: "confirming", message: "正在向 B 站确认登录状态，暂时连不上的话会自动重试" },
		],
		[
			"logged-out/notLogin → 没登录",
			{ status: "logged-out", reason: "notLogin" },
			{ status: "logged-out" },
		],
		[
			"logged-out/authLost → 已登录的登录失效了(expired)",
			{ status: "logged-out", reason: "authLost" },
			{ status: "expired", message: "账号登录已失效，请重新扫码登录" },
		],
		[
			"qr/ready → 等待扫码,带二维码与真过期时刻",
			{ status: "qr", phase: "ready", dataUrl: QR, expiresAt: EXPIRES },
			{ status: "awaiting-scan", qr: { dataUrl: QR, expiresAt: EXPIRES } },
		],
		[
			"qr/waiting-scan → 等待扫码",
			{ status: "qr", phase: "waiting-scan", dataUrl: QR, expiresAt: EXPIRES },
			{ status: "awaiting-scan", qr: { dataUrl: QR, expiresAt: EXPIRES } },
		],
		[
			"qr/waiting-confirm → 正在确认(已扫等手机确认),不带二维码",
			{ status: "qr", phase: "waiting-confirm", dataUrl: QR, expiresAt: EXPIRES },
			{ status: "confirming", message: "已扫码，请在手机上确认" },
		],
		[
			"logged-in(卡片没取到的那一小段)→ 已经是 logged-in",
			{ status: "logged-in", reason: "loginJustSucceeded", loggedInAt: SINCE },
			{ status: "logged-in", loggedInAt: SINCE },
		],
		[
			"logged-in(卡片取到)→ logged-in,loggedInAt 不变",
			{ status: "logged-in", reason: "loggedIn", loggedInAt: SINCE, card: CARD },
			{ status: "logged-in", loggedInAt: SINCE },
		],
		[
			"logged-in(账号信息暂时取不到)→ 仍是 logged-in",
			{ status: "logged-in", reason: "fetchAccountFailed", loggedInAt: SINCE, card: CARD },
			{ status: "logged-in", loggedInAt: SINCE },
		],
		[
			"failed/qrExpired → error(不是 expired)",
			{ status: "failed", reason: "qrExpired" },
			{ status: "error", message: "二维码已超时（3分钟），请重新登录" },
		],
		[
			"failed/qrInvalidated → error",
			{ status: "failed", reason: "qrInvalidated" },
			{ status: "error", message: "二维码已失效，请重新登录" },
		],
		[
			"failed/qrFetchFailed → error",
			{ status: "failed", reason: "qrFetchFailed" },
			{ status: "error", message: "获取二维码失败，请重试" },
		],
		[
			"failed/noCookieAfterLogin → error",
			{ status: "failed", reason: "noCookieAfterLogin" },
			{ status: "error", message: "登录成功但未获取到 cookie，请重试" },
		],
		[
			"qr 没有图(登出后迟到的一拍轮询)→ 没有东西可扫,按没登录",
			{ status: "qr", phase: "waiting-scan", dataUrl: undefined, expiresAt: EXPIRES },
			{ status: "logged-out" },
		],
	];

	it.each(rows)("%s", (_name, state, expected) => {
		expect(authStateFromLoginState(state)).toEqual(expected);
	});
});
