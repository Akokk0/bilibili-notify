/**
 * 单元测试 — `handleAuthEnvelope` 纯函数(WS `auth` 频道事件分发)。
 *
 * 守护契约:
 *   - 非 auth 频道帧 silent-drop(防止跨 channel 误触发)
 *   - login-status-report → setSnapshot(snap)
 *   - cookies-refreshed → setCookiesRefreshed(优先 data.refreshedAt,fallback env.ts)
 *   - auth-lost → setSnapshot(NOT_LOGIN, "auth-lost")
 *   - 不识别的 event 不动 store
 */

import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { WsEnvelope } from "../../services/ws";
import { useAuthStore } from "../../store/auth";
import { BiliLoginStatus, type LoginSnapshot } from "../../types/auth";
import { handleAuthEnvelope } from "../useAuthChannel";

function resetStore(): void {
	useAuthStore.getState().clear();
}

function env(over: Partial<WsEnvelope> & { type: string }): WsEnvelope {
	return { ts: "2026-05-16T00:00:00.000Z", ...over };
}

describe("handleAuthEnvelope — auth 频道事件分发", () => {
	beforeEach(resetStore);

	it("非 auth 频道帧:不动 store", () => {
		handleAuthEnvelope(env({ type: "log", event: "engine-error", data: ["x", "y"] }));
		expect(useAuthStore.getState().snapshot).toBe(null);
	});

	it("login-status-report:写入 snapshot", () => {
		const snap: LoginSnapshot = {
			status: BiliLoginStatus.LOGGED_IN,
			msg: "ok",
		};
		handleAuthEnvelope(env({ type: "auth", event: "login-status-report", data: snap }));
		expect(useAuthStore.getState().snapshot).toEqual(snap);
	});

	it("login-status-report 但 data 缺失:不动 store(防御性)", () => {
		handleAuthEnvelope(env({ type: "auth", event: "login-status-report" }));
		expect(useAuthStore.getState().snapshot).toBe(null);
	});

	it("cookies-refreshed:优先 data.refreshedAt", () => {
		const refreshedAt = "2026-05-16T10:00:00.000Z";
		handleAuthEnvelope(
			env({
				type: "auth",
				event: "cookies-refreshed",
				data: { refreshedAt },
				ts: "2020-01-01T00:00:00.000Z",
			}),
		);
		expect(useAuthStore.getState().cookiesRefreshedAt).toBe(refreshedAt);
	});

	it("cookies-refreshed 缺 data.refreshedAt:fallback 用 env.ts", () => {
		const ts = "2026-05-16T11:00:00.000Z";
		handleAuthEnvelope(env({ type: "auth", event: "cookies-refreshed", data: {}, ts }));
		expect(useAuthStore.getState().cookiesRefreshedAt).toBe(ts);
	});

	it("auth-lost:写入 NOT_LOGIN snapshot", () => {
		handleAuthEnvelope(env({ type: "auth", event: "auth-lost" }));
		const snap = useAuthStore.getState().snapshot;
		expect(snap?.status).toBe(BiliLoginStatus.NOT_LOGIN);
		expect(snap?.msg).toBe("auth-lost");
	});

	it("不识别的 event:不动 store", () => {
		handleAuthEnvelope(env({ type: "auth", event: "subscribed" }));
		expect(useAuthStore.getState().snapshot).toBe(null);
	});
});
