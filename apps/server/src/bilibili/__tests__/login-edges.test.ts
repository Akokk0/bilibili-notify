import type { AuthState, SourceAuth } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { watchLoginEdges } from "../login-edges.js";

const LOGGED_IN: AuthState = {
	status: "logged-in",
	loggedInAt: "2026-10-25T00:00:00.000Z",
};
const LOGGED_OUT: AuthState = { status: "logged-out" };
const EXPIRED: AuthState = { status: "expired", message: "账号登录已失效" };
const CONFIRMING: AuthState = { status: "confirming" };
const AWAITING_SCAN: AuthState = {
	status: "awaiting-scan",
	qr: {
		dataUrl: "data:image/png;base64,AA==",
		expiresAt: "2026-10-25T00:03:00.000Z",
	},
};
const ERROR: AuthState = { status: "error", message: "二维码已超时" };

function makeAuth(initial: AuthState) {
	let state = initial;
	const listeners = new Set<() => void>();
	const auth: Pick<SourceAuth, "state" | "onChange"> = {
		state: () => state,
		onChange(fn) {
			listeners.add(fn);
			return { dispose: () => void listeners.delete(fn) };
		},
	};
	return {
		auth,
		set(next: AuthState) {
			state = next;
			for (const fn of [...listeners]) fn();
		},
		listenerCount: () => listeners.size,
	};
}

function observe(auth: Pick<SourceAuth, "state" | "onChange">) {
	const lost = vi.fn();
	const restored = vi.fn();
	const watch = watchLoginEdges(auth, { onLost: lost, onRestored: restored });
	return { lost, restored, watch };
}

describe("watchLoginEdges", () => {
	it("开机已登录：没有登录边", () => {
		const h = makeAuth(LOGGED_IN);
		const seen = observe(h.auth);

		h.set({ ...LOGGED_IN, loggedInAt: "2026-10-25T00:01:00.000Z" });

		expect(seen.lost).not.toHaveBeenCalled();
		expect(seen.restored).not.toHaveBeenCalled();
	});

	it("开机未登录，之后登上：restored 一次", () => {
		const h = makeAuth(LOGGED_OUT);
		const seen = observe(h.auth);

		h.set(LOGGED_IN);

		expect(seen.lost).not.toHaveBeenCalled();
		expect(seen.restored).toHaveBeenCalledTimes(1);
	});

	it("运行中掉线：lost 一次", () => {
		const h = makeAuth(LOGGED_IN);
		const seen = observe(h.auth);

		h.set(EXPIRED);

		expect(seen.lost).toHaveBeenCalledTimes(1);
		expect(seen.restored).not.toHaveBeenCalled();
	});

	it("掉线后重登：lost 一次、restored 一次", () => {
		const h = makeAuth(LOGGED_IN);
		const seen = observe(h.auth);

		h.set(EXPIRED);
		h.set(LOGGED_IN);

		expect(seen.lost).toHaveBeenCalledTimes(1);
		expect(seen.restored).toHaveBeenCalledTimes(1);
	});

	it("手动退出登录：lost 一次", () => {
		const h = makeAuth(LOGGED_IN);
		const seen = observe(h.auth);

		h.set(LOGGED_OUT);

		expect(seen.lost).toHaveBeenCalledTimes(1);
		expect(seen.restored).not.toHaveBeenCalled();
	});

	it("已登录时重扫、不扫等超时：没有登录边", () => {
		const h = makeAuth(LOGGED_IN);
		const seen = observe(h.auth);

		h.set(AWAITING_SCAN);
		h.set(ERROR);
		h.set(LOGGED_IN);

		expect(seen.lost).not.toHaveBeenCalled();
		expect(seen.restored).not.toHaveBeenCalled();
	});

	it("重扫途中撞 -101 再登上：没有 lost、restored 一次", () => {
		const h = makeAuth(LOGGED_IN);
		const seen = observe(h.auth);

		h.set(AWAITING_SCAN);
		h.set(EXPIRED);
		h.set(LOGGED_IN);

		expect(seen.lost).not.toHaveBeenCalled();
		expect(seen.restored).toHaveBeenCalledTimes(1);
	});

	it("开机停在 confirming、后来心跳成功：restored 一次", () => {
		const h = makeAuth(CONFIRMING);
		const seen = observe(h.auth);

		h.set(LOGGED_IN);

		expect(seen.lost).not.toHaveBeenCalled();
		expect(seen.restored).toHaveBeenCalledTimes(1);
	});

	it("摘掉之后不再叫", () => {
		const h = makeAuth(LOGGED_IN);
		const seen = observe(h.auth);

		seen.watch.dispose();
		h.set(EXPIRED);
		h.set(LOGGED_IN);

		expect(h.listenerCount()).toBe(0);
		expect(seen.lost).not.toHaveBeenCalled();
		expect(seen.restored).not.toHaveBeenCalled();
	});
});
