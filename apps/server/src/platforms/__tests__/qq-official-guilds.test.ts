import type { HttpClient } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { integrationIo } from "../../__tests__/support/integration-io.js";
import { fetchQQGuildChannels } from "../qq-official";
import type { QQOfficialConnectionSettings } from "../qq-official-settings.js";

const CFG: QQOfficialConnectionSettings = {
	appId: "APPID",
	appSecret: "SECRET",
	sandbox: false,
	botType: "public",
	logReconnects: false,
};

let fetchMock: ReturnType<typeof vi.fn>;
let http: HttpClient;
/** 真的 `Response`:请求客户端要读头、读字节。 */
function res(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	http = integrationIo().http;
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchQQGuildChannels — REST 枚举频道(token → /guilds → /channels)", () => {
	it("取 token → 列频道服务器 → 逐个列子频道,只保留文字子频道(type 0)", async () => {
		fetchMock.mockImplementation(async (target: URL) => {
			const url = String(target);
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "TKN", expires_in: 7200 });
			if (url.endsWith("/users/@me/guilds")) return res(200, [{ id: "G1", name: "测试频道" }]);
			if (url.endsWith("/guilds/G1/channels"))
				return res(200, [
					{ id: "C1", name: "公告", type: 0 },
					{ id: "C2", name: "语音房", type: 2 },
				]);
			return res(404, {});
		});
		const guilds = await fetchQQGuildChannels(http, CFG);
		expect(guilds).toEqual([
			{ guildId: "G1", name: "测试频道", channels: [{ channelId: "C1", name: "公告", type: 0 }] },
		]);
		// 鉴权头带到了 REST 调用;线上只有这两个头(不带浏览器身份、不带 Cookie)
		const guildsCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/users/@me/guilds"));
		if (!guildsCall) throw new Error("expected a guilds fetch call");
		const headers = new Headers((guildsCall[1] as RequestInit).headers);
		expect(Object.fromEntries(headers)).toEqual({
			authorization: "QQBot TKN",
			"x-union-appid": "APPID",
		});
	});

	it("沙箱:走 sandbox host", async () => {
		fetchMock.mockImplementation(async (target: URL) => {
			if (String(target).includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return res(200, []);
		});
		await fetchQQGuildChannels(http, { ...CFG, sandbox: true });
		const guildsCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/users/@me/guilds"));
		expect(String(guildsCall?.[0])).toBe("https://sandbox.api.sgroup.qq.com/users/@me/guilds");
	});

	it("列频道服务器 HTTP 失败 → 抛错", async () => {
		fetchMock.mockImplementation(async (target: URL) => {
			if (String(target).includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return res(401, {});
		});
		await expect(fetchQQGuildChannels(http, CFG)).rejects.toThrow(/401/);
	});

	it("某子频道列表失败 → 跳过该 guild(不整体崩)", async () => {
		fetchMock.mockImplementation(async (target: URL) => {
			const url = String(target);
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			if (url.endsWith("/users/@me/guilds"))
				return res(200, [
					{ id: "G1", name: "甲" },
					{ id: "G2", name: "乙" },
				]);
			if (url.endsWith("/guilds/G1/channels")) return res(500, {});
			if (url.endsWith("/guilds/G2/channels"))
				return res(200, [{ id: "C9", name: "通知", type: 0 }]);
			return res(404, {});
		});
		const guilds = await fetchQQGuildChannels(http, CFG);
		expect(guilds).toEqual([
			{ guildId: "G2", name: "乙", channels: [{ channelId: "C9", name: "通知", type: 0 }] },
		]);
	});

	it("路由断开(调用方中止了在途的请求)→ 抛错,不当成跳过", async () => {
		fetchMock.mockImplementation(async (target: URL, init: RequestInit) => {
			if (String(target).includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return new Promise((_resolve, reject) => {
				(init.signal as AbortSignal).addEventListener("abort", () => {
					reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
				});
			});
		});
		const ac = new AbortController();
		const pending = fetchQQGuildChannels(http, CFG, ac.signal).catch((e: unknown) => e);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		ac.abort();
		expect(await pending).toBeInstanceOf(Error);
	});
});
