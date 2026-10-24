import { ok } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { RiskControlError } from "..";
import { makeApi } from "./support/make-api";

function httpReply(status: number, target: string | URL) {
	return {
		ok: true as const,
		url: String(target),
		status,
		headers: new Headers(),
		body: new Uint8Array(),
		isSuccess: status >= 200 && status < 300,
		text: () => "",
		json: () => ok({ value: undefined }),
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("HTTP 412 风控页算风控", () => {
	it("fetchUserCard 撞 412 → rate_limited,不带 upstreamCode,不重试", async () => {
		const { api, http } = await makeApi();
		const fetch = vi
			.spyOn(http, "fetch")
			.mockImplementation((target) => Promise.resolve(httpReply(412, target)));

		const result = await api.fetchUserCard("42");

		expect(result).toEqual({
			ok: false,
			code: "rate_limited",
			message: expect.stringContaining("412"),
		});
		expect(result).not.toHaveProperty("upstreamCode");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("wbi 请求撞 412 → rate_limited,只 GET 一次、不补 ticket", async () => {
		const { api, http } = await makeApi();
		(api as unknown as { wbiKeys: { imgKey: string; subKey: string } }).wbiKeys = {
			imgKey: "a".repeat(32),
			subKey: "b".repeat(32),
		};
		const fetch = vi
			.spyOn(http, "fetch")
			.mockImplementation((target) => Promise.resolve(httpReply(412, target)));

		const result = await api.fetchLiveRoomInfoStreamKey("42");

		expect(result).toMatchObject({ ok: false, code: "rate_limited" });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
	});

	it("回原始体的方法撞 412 → 以 RiskControlError 拒绝,只出网一次", async () => {
		const { api, http } = await makeApi();
		const fetch = vi
			.spyOn(http, "fetch")
			.mockImplementation((target) => Promise.resolve(httpReply(412, target)));

		await expect(api.fetchLiveRoomInfo("42")).rejects.toBeInstanceOf(RiskControlError);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("别的非 2xx 照旧重试满 4 次,抛普通错误", async () => {
		vi.useFakeTimers();
		const { api, http } = await makeApi();
		const fetch = vi
			.spyOn(http, "fetch")
			.mockImplementation((target) => Promise.resolve(httpReply(500, target)));

		const rejection = api.fetchLiveRoomInfo("42").catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(2_000);
		const error = await rejection;

		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(RiskControlError);
		expect(fetch).toHaveBeenCalledTimes(4);
	});
});
