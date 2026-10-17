/**
 * 上舰观众头像(`createViewerAvatarFetcher`,3b-18 提交 4):查头像地址撞到限流(rate_limited)之后,
 * 冷却期内所有直播间的上舰都不再查(卡照出、没有观众头像),到点再试。接口与抓图用假的,时间经 `now` 注入。
 */

import { fail, type ImageRef, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { failureFromBili } from "../../error-codes.js";
import { createViewerAvatarFetcher, VIEWER_AVATAR_COOLDOWN_MS } from "../viewer-avatar.js";

const FACE = "https://i0.hdslb.com/bfs/face/abc.jpg";
const refOf = (url: string): ImageRef =>
	`${Buffer.from(url).toString("hex").padEnd(64, "0").slice(0, 64)}.jpg`;

type InfoReply = Awaited<
	ReturnType<Parameters<typeof createViewerAvatarFetcher>[0]["api"]["fetchUserInfoInLive"]>
>;

function setup(reply: () => InfoReply | Promise<InfoReply> = () => ok({ data: { face: FACE } })) {
	let clock = 5_000_000;
	const fetchUserInfoInLive = vi.fn(async (_viewer: string, _up: string) => reply());
	const fetchImage = vi.fn(async (url: string) => ok({ ref: refOf(url) }));
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const fetcher = createViewerAvatarFetcher({
		api: { fetchUserInfoInLive },
		images: { fetchImage },
		logger,
		now: () => clock,
	});
	return {
		fetcher,
		fetchUserInfoInLive,
		fetchImage,
		logger,
		advance: (ms: number) => (clock += ms),
	};
}

describe("createViewerAvatarFetcher", () => {
	it("查到地址 → 抓成图库引用;查的是(观众 uid, 主播 uid)", async () => {
		const w = setup();

		const ref = await w.fetcher.fetch("7", "u1");

		expect(w.fetchUserInfoInLive).toHaveBeenCalledExactlyOnceWith("7", "u1");
		expect(ref).toBe(refOf(`${FACE}@480w_80q_1s.webp`));
		expect(w.logger.warn).not.toHaveBeenCalled();
	});

	it.each([
		["没给地址", () => ok({ data: { uname: "船员" } as { face?: string } })],
		["data 是 null", () => ok({ data: null })],
		["没对照的码", () => failureFromBili(4101132, "没见过")],
		["未登录", () => failureFromBili(-101, "账号未登录")],
		["回应形状不对", () => fail("unavailable", "回应不是预期的形状")],
	] as const)("%s:没有头像,不进冷却(下一次照查)", async (_name, reply) => {
		const w = setup(reply);

		expect(await w.fetcher.fetch("7", "u1")).toBeUndefined();
		await w.fetcher.fetch("8", "u1");

		expect(w.fetchUserInfoInLive).toHaveBeenCalledTimes(2);
		expect(w.logger.warn).not.toHaveBeenCalled();
	});

	it("接口抛错:没有头像、记一条 warn,不进冷却", async () => {
		const w = setup();
		w.fetchUserInfoInLive.mockRejectedValueOnce(new Error("网络断了"));

		expect(await w.fetcher.fetch("7", "u1")).toBeUndefined();
		expect(w.logger.warn).toHaveBeenCalledTimes(1);
		await w.fetcher.fetch("8", "u1");

		expect(w.fetchUserInfoInLive).toHaveBeenCalledTimes(2);
	});

	it.each([-352, -412, -799, -509])(
		"撞到 %i:这一次没有头像;冷却期内(任何观众、任何主播)不再查接口",
		async (code) => {
			const w = setup(() => failureFromBili(code, "请求被拦截"));

			expect(await w.fetcher.fetch("7", "u1")).toBeUndefined();
			expect(w.fetchUserInfoInLive).toHaveBeenCalledTimes(1);

			w.advance(VIEWER_AVATAR_COOLDOWN_MS - 1);
			expect(await w.fetcher.fetch("8", "u2")).toBeUndefined();
			expect(w.fetchUserInfoInLive).toHaveBeenCalledTimes(1);
			expect(w.fetchImage).not.toHaveBeenCalled();
		},
	);

	it("进冷却时只记一条 warn(带码与原话),冷却期内的跳过不再记", async () => {
		const w = setup(() => failureFromBili(-352, "风控校验失败"));

		await w.fetcher.fetch("7", "u1");
		await w.fetcher.fetch("8", "u1");
		await w.fetcher.fetch("9", "u1");

		expect(w.logger.warn).toHaveBeenCalledTimes(1);
		expect(w.logger.warn.mock.calls[0]?.[0]).toContain("-352");
		expect(w.logger.warn.mock.calls[0]?.[0]).toContain("风控校验失败");
	});

	it("过了冷却:再查一次;又撞到就再冷却一轮、再记一条 warn;查成功了就恢复", async () => {
		let limited = true;
		const w = setup(() => (limited ? failureFromBili(-412, "拦截") : ok({ data: { face: FACE } })));

		await w.fetcher.fetch("7", "u1");
		w.advance(VIEWER_AVATAR_COOLDOWN_MS);
		await w.fetcher.fetch("8", "u1"); // 到点,又撞
		expect(w.fetchUserInfoInLive).toHaveBeenCalledTimes(2);
		expect(w.logger.warn).toHaveBeenCalledTimes(2);

		w.advance(VIEWER_AVATAR_COOLDOWN_MS - 1);
		await w.fetcher.fetch("9", "u1");
		expect(w.fetchUserInfoInLive).toHaveBeenCalledTimes(2);

		limited = false;
		w.advance(1);
		expect(await w.fetcher.fetch("10", "u1")).toBe(refOf(`${FACE}@480w_80q_1s.webp`));
		await w.fetcher.fetch("11", "u1");
		expect(w.fetchUserInfoInLive).toHaveBeenCalledTimes(4);
	});

	it("同时在途的两次都撞到限流:只进一次冷却、只记一条 warn", async () => {
		const w = setup(() => failureFromBili(-352, "拦截"));

		await Promise.all([w.fetcher.fetch("7", "u1"), w.fetcher.fetch("8", "u2")]);

		expect(w.logger.warn).toHaveBeenCalledTimes(1);
	});
});
