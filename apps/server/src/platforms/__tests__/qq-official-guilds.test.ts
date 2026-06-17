import type { QQOfficialAdapterConfig } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQQGuildChannels } from "../qq-official";

const CFG: QQOfficialAdapterConfig = {
	appId: "APPID",
	appSecret: "SECRET",
	sandbox: false,
	botType: "public",
};

let fetchMock: ReturnType<typeof vi.fn>;
function res(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchQQGuildChannels — REST 枚举频道(token → /guilds → /channels)", () => {
	it("取 token → 列频道服务器 → 逐个列子频道,只保留文字子频道(type 0)", async () => {
		fetchMock.mockImplementation(async (url: string) => {
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
		const guilds = await fetchQQGuildChannels(CFG);
		expect(guilds).toEqual([
			{ guildId: "G1", name: "测试频道", channels: [{ channelId: "C1", name: "公告", type: 0 }] },
		]);
		// 鉴权头带到了 REST 调用
		const guildsCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/users/@me/guilds"));
		const headers = (guildsCall?.[1] as { headers: Record<string, string> }).headers;
		expect(headers.authorization).toBe("QQBot TKN");
		expect(headers["x-union-appid"]).toBe("APPID");
	});

	it("沙箱:走 sandbox host", async () => {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return res(200, []);
		});
		await fetchQQGuildChannels({ ...CFG, sandbox: true });
		const guildsCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/users/@me/guilds"));
		expect(String(guildsCall?.[0])).toBe("https://sandbox.api.sgroup.qq.com/users/@me/guilds");
	});

	it("列频道服务器 HTTP 失败 → 抛错", async () => {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return res(401, {});
		});
		await expect(fetchQQGuildChannels(CFG)).rejects.toThrow(/401/);
	});

	it("某子频道列表失败 → 跳过该 guild(不整体崩)", async () => {
		fetchMock.mockImplementation(async (url: string) => {
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
		const guilds = await fetchQQGuildChannels(CFG);
		expect(guilds).toEqual([
			{ guildId: "G2", name: "乙", channels: [{ channelId: "C9", name: "通知", type: 0 }] },
		]);
	});
});
