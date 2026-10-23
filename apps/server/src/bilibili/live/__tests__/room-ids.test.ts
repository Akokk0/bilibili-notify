import {
	fail,
	type Logger,
	ok,
	type Result,
	type SourceSubscriptionView,
} from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { memoryKeyValueStores } from "../../../__tests__/support/memory-key-value-store.js";
import type { UserInfoResponse } from "../../api/index.js";
import { createRoomIds } from "../room-ids.js";

const ROOM_ID = 5050;

function harness(subscribed = ["42"]) {
	const state = memoryKeyValueStores("state");
	const fetchUserInfo = vi.fn(
		async (_externalId: string): Promise<Result<{ data: UserInfoResponse["data"] }>> =>
			ok({ data: { live_room: { roomid: ROOM_ID } } }),
	);
	let subscriptions: string[] = subscribed;
	const ids = createRoomIds({
		api: { fetchUserInfo },
		state: state.store,
		subscriptions: () =>
			subscriptions.map(
				(externalId): SourceSubscriptionView => ({
					externalId,
					features: new Set(),
					monitorsLive: true,
				}),
			),
		setTimeout: (fn: () => void, ms: number) => {
			const timer = globalThis.setTimeout(fn, ms);
			return { dispose: () => globalThis.clearTimeout(timer) };
		},
		now: Date.now,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		} as unknown as Logger,
	});
	return {
		ids,
		state: state.store,
		fetchUserInfo,
		setSubscriptions(next: string[]) {
			subscriptions = next;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("RoomIds", () => {
	it("state 里的正整数房号直接复用,不出网", async () => {
		const h = harness();
		await h.state.set("room:42", "5050");

		await expect(h.ids.resolve("42")).resolves.toEqual(ok({ roomId: "5050" }));

		expect(h.fetchUserInfo).not.toHaveBeenCalled();
	});

	it("解出的房号写进这个人的 room 键,下次直接用", async () => {
		const h = harness();

		await expect(h.ids.resolve("42")).resolves.toEqual(ok({ roomId: "5050" }));
		await expect(h.ids.resolve("42")).resolves.toEqual(ok({ roomId: "5050" }));

		expect(h.state.get("room:42")).toBe("5050");
		expect(h.fetchUserInfo).toHaveBeenCalledTimes(1);
	});

	it("同一个人并发解析两次只出一发", async () => {
		const h = harness();
		let release: (result: Result<{ data: UserInfoResponse["data"] }>) => void = () => {};
		h.fetchUserInfo.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);

		const first = h.ids.resolve("42");
		const second = h.ids.resolve("42");
		await vi.waitFor(() => expect(h.fetchUserInfo).toHaveBeenCalledTimes(1));
		release(ok({ data: { live_room: { roomid: ROOM_ID } } }));

		await expect(Promise.all([first, second])).resolves.toEqual([
			ok({ roomId: "5050" }),
			ok({ roomId: "5050" }),
		]);
		expect(h.fetchUserInfo).toHaveBeenCalledTimes(1);
	});

	it("两个人的请求之间隔 300ms", async () => {
		vi.useFakeTimers();
		const h = harness(["42", "43"]);

		const first = h.ids.resolve("42");
		const second = h.ids.resolve("43");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.fetchUserInfo).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(299);
		expect(h.fetchUserInfo).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		await expect(Promise.all([first, second])).resolves.toEqual([
			ok({ roomId: "5050" }),
			ok({ roomId: "5050" }),
		]);
		expect(h.fetchUserInfo.mock.calls.map(([externalId]) => externalId)).toEqual(["42", "43"]);
	});

	it("不在名单里的人解出来也不写 state", async () => {
		const h = harness([]);

		await expect(h.ids.resolve("42")).resolves.toEqual(ok({ roomId: "5050" }));

		expect(h.state.get("room:42")).toBeUndefined();
	});

	it("名单少了人,删掉他的 room 键", async () => {
		const h = harness();
		await h.state.set("room:42", "5050");
		h.setSubscriptions([]);

		h.ids.syncSubscriptions();

		await vi.waitFor(() => expect(h.state.get("room:42")).toBeUndefined());
	});

	it.each([0, -1, undefined])("roomid 是 %s 时回 not_found,不写 state", async (roomid) => {
		const h = harness();
		h.fetchUserInfo.mockResolvedValue(ok({ data: { live_room: { roomid } } }));

		await expect(h.ids.resolve("42")).resolves.toMatchObject({
			ok: false,
			code: "not_found",
		});

		expect(h.state.get("room:42")).toBeUndefined();
	});

	it("请求层的失败原样交回", async () => {
		const h = harness();
		const failure = fail("rate_limited", "risk control");
		h.fetchUserInfo.mockResolvedValue(failure);

		await expect(h.ids.resolve("42")).resolves.toEqual(failure);

		expect(h.state.get("room:42")).toBeUndefined();
	});

	it("请求抛错收成 unavailable", async () => {
		const h = harness();
		h.fetchUserInfo.mockRejectedValue(new Error("network down"));

		await expect(h.ids.resolve("42")).resolves.toMatchObject({
			ok: false,
			code: "unavailable",
			message: "network down",
		});

		expect(h.state.get("room:42")).toBeUndefined();
	});
});
