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
import { eventFrameMaker } from "./ws-frames";

function resetStore(): void {
	useAuthStore.getState().clear();
}

const TS = "2026-05-16T00:00:00.000Z";

/** 服务端发来的一帧合法事件帧:形状按 contract 的事件表写全,缺 `ts` 补上。 */
const env = eventFrameMaker(TS);

/** 故意违反类型的坏帧(`data` 缺格 / 类型不对、事件名不存在),测 hook 的防御。 */
const malformed = (frame: object) => ({ ts: TS, ...frame }) as WsEnvelope;

describe("handleAuthEnvelope — auth 频道事件分发", () => {
	beforeEach(resetStore);

	it("非 auth 频道帧:不动 store", () => {
		handleAuthEnvelope(
			env({ type: "log", event: "engine-error", data: { source: "x", message: "y" } }),
		);
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
		handleAuthEnvelope(malformed({ type: "auth", event: "login-status-report" }));
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
		handleAuthEnvelope(malformed({ type: "auth", event: "cookies-refreshed", data: {}, ts }));
		expect(useAuthStore.getState().cookiesRefreshedAt).toBe(ts);
	});

	it("auth-lost:写入 NOT_LOGIN snapshot", () => {
		handleAuthEnvelope(env({ type: "auth", event: "auth-lost", data: null }));
		const snap = useAuthStore.getState().snapshot;
		expect(snap?.status).toBe(BiliLoginStatus.NOT_LOGIN);
		expect(snap?.msg).toBe("auth-lost");
	});

	it("不识别的 event:不动 store", () => {
		handleAuthEnvelope(malformed({ type: "auth", event: "subscribed" }));
		expect(useAuthStore.getState().snapshot).toBe(null);
	});
});
