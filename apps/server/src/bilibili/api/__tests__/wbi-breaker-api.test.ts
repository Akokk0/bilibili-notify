import { ok } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeApi } from "./support/make-api";

const BASE_TIME = 1_700_000_000_000;

function httpReply(status: number, body: unknown, target: string | URL) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return {
		ok: true as const,
		url: String(target),
		status,
		headers: new Headers(),
		body: new TextEncoder().encode(text),
		isSuccess: status >= 200 && status < 300,
		text: () => text,
		json: () => ok({ value: body }),
	};
}

async function setup(answer: () => { status: number; body: unknown }) {
	const w = await makeApi();
	const calls = { get: 0, post: 0 };
	const keys = { imgKey: "a".repeat(32), subKey: "b".repeat(32) };
	(w.api as unknown as { wbiKeys: typeof keys }).wbiKeys = { ...keys };
	const fetch = vi.spyOn(w.http, "fetch").mockImplementation((target, options) => {
		if (options?.method === "POST") {
			calls.post++;
			return Promise.resolve(
				httpReply(
					200,
					{
						code: 0,
						data: {
							nav: {
								img: `https://x/${"a".repeat(32)}.png`,
								sub: `https://x/${"b".repeat(32)}.png`,
							},
						},
					},
					target,
				),
			);
		}
		calls.get++;
		const reply = answer();
		return Promise.resolve(httpReply(reply.status, reply.body, target));
	});
	return { ...w, calls, fetch, keys };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Api 的 wbi 熔断", () => {
	it("持续 -352 开闸后其余 wbi 方法不出网，wbiKeys 保持不变", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(BASE_TIME);
		const w = await setup(() => ({ status: 200, body: { code: -352, message: "blocked" } }));

		expect(await w.api.fetchUserInfo("42")).toMatchObject({
			ok: false,
			code: "rate_limited",
			upstreamCode: -352,
		});
		const callsAfterOpen = { ...w.calls };
		const keysAfterOpen = {
			...(w.api as unknown as { wbiKeys: typeof w.keys }).wbiKeys,
		};

		for (const result of [
			await w.api.fetchLiveRoomInfoStreamKey("1"),
			await w.api.fetchUserVideos("42"),
			await w.api.searchByType("video", "keyword"),
		]) {
			expect(result).toMatchObject({
				ok: false,
				code: "rate_limited",
				upstreamCode: -352,
			});
		}
		expect(w.calls).toEqual(callsAfterOpen);
		expect((w.api as unknown as { wbiKeys: typeof w.keys }).wbiKeys).toEqual(keysAfterOpen);
	});

	it("60 秒后只放一个试探，成功后后续调用照常出网", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(BASE_TIME);
		let body: unknown = { code: -352, message: "blocked" };
		const w = await setup(() => ({ status: 200, body }));
		await w.api.fetchUserInfo("42");

		vi.setSystemTime(BASE_TIME + 60_000);
		body = { code: 0, data: { token: "ok" } };
		const beforeProbe = { ...w.calls };
		expect(await w.api.fetchLiveRoomInfoStreamKey("1")).toMatchObject({ ok: true });
		expect(w.calls).toEqual({ get: beforeProbe.get + 1, post: beforeProbe.post });

		body = { code: 0, data: { list: [] } };
		const beforeNext = { ...w.calls };
		expect(await w.api.fetchUserVideos("42")).toMatchObject({ ok: true });
		expect(w.calls).toEqual({ get: beforeNext.get + 1, post: beforeNext.post });
	});

	it("wbi 方法撞 HTTP 412 也开闸，后续调用不出网", async () => {
		const w = await setup(() => ({ status: 412, body: "" }));

		expect(await w.api.fetchUserInfo("42")).toMatchObject({
			ok: false,
			code: "rate_limited",
			message: expect.stringContaining("412"),
		});
		const callsAfterOpen = { ...w.calls };
		expect(await w.api.fetchLiveRoomInfoStreamKey("1")).toMatchObject({
			ok: false,
			code: "rate_limited",
		});
		expect(w.calls).toEqual(callsAfterOpen);
	});

	it("新登录成立后清闸，下一个调用直接出网", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(BASE_TIME);
		let body: unknown = { code: -352, message: "blocked" };
		const w = await setup(() => ({ status: 200, body }));
		await w.api.fetchUserInfo("42");
		const callsAfterOpen = { ...w.calls };

		await w.api.resumeStoredLogin();
		expect(w.calls).toEqual(callsAfterOpen);
		body = { code: 0, data: { token: "ok" } };
		expect(await w.api.fetchLiveRoomInfoStreamKey("1")).toMatchObject({ ok: true });
		expect(w.calls).toEqual({ get: callsAfterOpen.get + 1, post: callsAfterOpen.post });
	});
});
