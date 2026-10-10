import type { Connection, Disposable, Logger, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "../qq-official";

function makeLogger(): Logger {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}
function makeServiceCtx(): ServiceContext {
	return {
		logger: makeLogger(),
		setTimeout(fn, ms): Disposable {
			const h = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(h) };
		},
		setInterval(fn, ms): Disposable {
			const h = setInterval(fn, ms);
			return { dispose: () => clearInterval(h) };
		},
		onDispose() {},
		signal: new AbortController().signal,
		track: () => {},
	};
}

function qqConnection(id = "a1"): Connection {
	return {
		id,
		name: "qq",
		adapterKey: "qq-official",
		platform: "qq-official",
		platformSnapshot: snapshotFor("qq-official"),
		enabled: true,
		settings: { appId: "APPID", appSecret: "SECRET", sandbox: false, botType: "public" },
	} as unknown as Connection;
}

function res(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

function makeAdapter() {
	const registry = createQQSessionRegistry();
	const adapter = createQQOfficialAdapter({
		logger: makeLogger(),
		serviceCtx: makeServiceCtx(),
		registry,
	});
	return { adapter, registry };
}

const SIGNAL = new AbortController().signal;

describe("QQ 官方适配器 listAddressCandidates — 群 / 私聊(内存发现表)", () => {
	it("group 只回群的、private 只回私聊的,最近的在前,没有提示名的项不带 name", async () => {
		const { adapter, registry } = makeAdapter();
		registry.record("a1", { scope: "group", openid: "G1", displayHint: "群甲" }, 1000);
		registry.record("a1", { scope: "private", openid: "U1" }, 2000);
		registry.record("a1", { scope: "group", openid: "G2" }, 3000);
		registry.record("a1", { scope: "private", openid: "U2", displayHint: "小乙" }, 4000);

		const group = await adapter.listAddressCandidates?.(qqConnection(), "group", SIGNAL);
		expect(group).toEqual({
			ok: true,
			candidates: [{ address: "G2" }, { address: "G1", name: "群甲" }],
		});
		// 没有提示名的项连 name 这个键都不带。
		expect(group?.ok && Object.keys(group.candidates[0] ?? {})).toEqual(["address"]);

		const priv = await adapter.listAddressCandidates?.(qqConnection(), "private", SIGNAL);
		expect(priv).toEqual({
			ok: true,
			candidates: [{ address: "U2", name: "小乙" }, { address: "U1" }],
		});
	});

	it("别的连接的记录不混进来;lastSeenMs 不出适配器", async () => {
		const { adapter, registry } = makeAdapter();
		registry.record("a1", { scope: "group", openid: "G1" }, 1000);
		registry.record("other", { scope: "group", openid: "GX", displayHint: "别家" }, 2000);
		const r = await adapter.listAddressCandidates?.(qqConnection("a1"), "group", SIGNAL);
		expect(r).toEqual({ ok: true, candidates: [{ address: "G1" }] });
		expect(JSON.stringify(r)).not.toContain("lastSeenMs");
	});

	it("group / private 不触发任何出网请求", async () => {
		const { adapter, registry } = makeAdapter();
		registry.record("a1", { scope: "group", openid: "G1" }, 1000);
		await adapter.listAddressCandidates?.(qqConnection(), "group", SIGNAL);
		await adapter.listAddressCandidates?.(qqConnection(), "private", SIGNAL);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("QQ 官方适配器 listAddressCandidates — 频道(现去 QQ 拉)", () => {
	function stubGuilds() {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "TKN", expires_in: 7200 });
			if (url.endsWith("/users/@me/guilds"))
				return res(200, [
					{ id: "G1", name: "频道甲" },
					{ id: "G2", name: "频道乙" },
				]);
			if (url.endsWith("/guilds/G1/channels"))
				return res(200, [
					{ id: "C1", name: "公告", type: 0 },
					{ id: "V1", name: "语音", type: 2 },
					{ id: "C2", name: "闲聊", type: 0 },
				]);
			if (url.endsWith("/guilds/G2/channels"))
				return res(200, [{ id: "C3", name: "动态", type: 0 }]);
			return res(404, {});
		});
	}

	it("摊平成每个文字子频道一项,四格齐,顺序是服务器的顺序、服务器内子频道的顺序", async () => {
		stubGuilds();
		const { adapter } = makeAdapter();
		const r = await adapter.listAddressCandidates?.(qqConnection(), "channel", SIGNAL);
		expect(r).toEqual({
			ok: true,
			candidates: [
				{ address: "C1", name: "公告", parentAddress: "G1", parentName: "频道甲" },
				{ address: "C2", name: "闲聊", parentAddress: "G1", parentName: "频道甲" },
				{ address: "C3", name: "动态", parentAddress: "G2", parentName: "频道乙" },
			],
		});
	});

	it("把 signal 传进每一个请求", async () => {
		stubGuilds();
		const { adapter } = makeAdapter();
		const ctl = new AbortController();
		await adapter.listAddressCandidates?.(qqConnection(), "channel", ctl.signal);
		expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
		for (const call of fetchMock.mock.calls) {
			expect((call[1] as RequestInit).signal).toBe(ctl.signal);
		}
	});

	it("上游拉失败 → unavailable,话里带上游的原因", async () => {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("getAppAccessToken")) return res(401, {});
			return res(404, {});
		});
		const { adapter } = makeAdapter();
		const r = await adapter.listAddressCandidates?.(qqConnection(), "channel", SIGNAL);
		expect(r?.ok).toBe(false);
		if (r && !r.ok) {
			expect(r.code).toBe("unavailable");
			expect(r.message).toMatch(/^列出频道失败：/);
			expect(r.message).toMatch(/401/);
		}
	});

	it("连不上 QQ(fetch 抛了)也是 unavailable,不往外抛", async () => {
		fetchMock.mockRejectedValue(new Error("socket hang up"));
		const { adapter } = makeAdapter();
		const r = await adapter.listAddressCandidates?.(qqConnection(), "channel", SIGNAL);
		expect(r).toEqual({ ok: false, code: "unavailable", message: "列出频道失败：socket hang up" });
	});
});
