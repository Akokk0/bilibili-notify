import {
	fail,
	type Identity,
	type ImageRef,
	type Json,
	type KeyValueStore,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeLogger } from "../../subscriptions/__tests__/fixtures.js";
import type { Api } from "../api/index.js";
import { createProfileFetcher } from "../profile.js";

const UID = "42";
const IDENTITY: Identity = { sourceKey: "bilibili", externalId: UID };
const AVATAR_REF = `${"a".repeat(64)}.webp` as ImageRef;
const AVATAR_URL = "https://i0.hdslb.com/bfs/face/a.jpg";
const CARD = {
	mid: UID,
	name: "阿甲",
	face: AVATAR_URL,
	sign: "简介",
	fans: 123,
	attention: 0,
	level_info: { current_level: 1 },
	official: { role: 0, title: "", type: -1 },
	vip: {
		type: 0,
		status: 0,
		vipStatus: 0,
		label: { text: "", img_label_uri_hans_static: "" },
	},
};

function setup() {
	let now = 1_000;
	const fetchUserCard = vi.fn<Api["fetchUserCard"]>(async () =>
		ok({
			data: {
				card: CARD,
				space: { s_img: "", l_img: "" },
				like_num: 0,
			},
		}),
	);
	const values = new Map<string, Json>();
	const state: Pick<KeyValueStore, "get" | "set" | "delete"> = {
		get<T extends Json>(key: string): T | undefined {
			return values.get(key) as T | undefined;
		},
		set: vi.fn(async (key: string, value: Json): Promise<Result> => {
			values.set(key, value);
			return ok();
		}),
		delete: vi.fn(async (key: string): Promise<Result> => {
			values.delete(key);
			return ok();
		}),
	};
	const fetchImage = vi.fn(async (): Promise<Result<{ ref: ImageRef }>> => ok({ ref: AVATAR_REF }));
	const problems = { reportRisk: vi.fn(), resolveRisk: vi.fn() };
	const logger = makeLogger();
	const roster = new Set([UID]);
	const fetcher = createProfileFetcher({
		api: { fetchUserCard },
		problems,
		state,
		images: { fetchImage },
		logger,
		subscriptions: () => [...roster].map((externalId) => ({ externalId })),
		now: () => now,
		setTimeout: (fn, ms) => {
			const timer = setTimeout(() => {
				now += ms;
				fn();
			}, ms);
			return { dispose: () => clearTimeout(timer) };
		},
	});
	return {
		fetcher,
		fetchUserCard,
		fetchImage,
		problems,
		logger,
		roster,
		values,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("createProfileFetcher", () => {
	it("从用户卡拉出名字、头像引用、简介和粉丝数", async () => {
		const h = setup();

		const result = await h.fetcher.fetchProfile(IDENTITY, new AbortController().signal);

		expect(result).toEqual(ok({ name: "阿甲", avatar: AVATAR_REF, bio: "简介", followers: 123 }));
		expect(h.fetchUserCard).toHaveBeenCalledWith(UID);
	});

	it("简介为空、粉丝数不是非负整数时不带这两格", async () => {
		const h = setup();
		h.fetchUserCard.mockResolvedValueOnce(
			ok({
				data: {
					card: { ...CARD, sign: "", fans: -1 },
					space: { s_img: "", l_img: "" },
					like_num: 0,
				},
			}),
		);

		const result = await h.fetcher.fetchProfile(IDENTITY, new AbortController().signal);

		expect(result).toEqual(ok({ name: "阿甲", avatar: AVATAR_REF }));
	});

	it("卡片名字为空时回 unavailable", async () => {
		const h = setup();
		h.fetchUserCard.mockResolvedValueOnce(
			ok({
				data: {
					card: { ...CARD, name: "", face: AVATAR_URL, sign: "", fans: 1 },
					space: { s_img: "", l_img: "" },
					like_num: 0,
				},
			}),
		);

		const result = await h.fetcher.fetchProfile(IDENTITY, new AbortController().signal);

		expect(result).toMatchObject({ ok: false, code: "unavailable" });
	});

	it("查无此人原样交回 not_found", async () => {
		const h = setup();
		const missing = fail("not_found", "查无此人", { upstreamCode: -404 });
		h.fetchUserCard.mockResolvedValueOnce(missing);

		const result = await h.fetcher.fetchProfile(IDENTITY, new AbortController().signal);

		expect(result).toBe(missing);
	});

	it("撞风控后 5 分钟内不出网;窗口过了再试,成功后清风控", async () => {
		const h = setup();
		h.fetchUserCard.mockResolvedValueOnce(fail("rate_limited", "风控", { upstreamCode: -352 }));
		const signal = new AbortController().signal;

		expect(await h.fetcher.fetchProfile(IDENTITY, signal)).toMatchObject({
			ok: false,
			code: "rate_limited",
		});
		expect(h.problems.reportRisk).toHaveBeenCalledWith("profile", { notify: false });

		h.advance(5 * 60_000 - 1);
		expect(await h.fetcher.fetchProfile(IDENTITY, signal)).toMatchObject({
			ok: false,
			code: "rate_limited",
		});
		expect(h.fetchUserCard).toHaveBeenCalledTimes(1);

		h.advance(1);
		expect(await h.fetcher.fetchProfile(IDENTITY, signal)).toMatchObject({ ok: true });
		expect(h.fetchUserCard).toHaveBeenCalledTimes(2);
		expect(h.problems.resolveRisk).toHaveBeenCalledWith("profile");
	});

	it("头像地址没变且状态里有引用:不抓图,直接交状态里的引用", async () => {
		const h = setup();
		h.values.set("profile:42", { avatarUrl: AVATAR_URL, avatar: AVATAR_REF });

		const result = await h.fetcher.fetchProfile(IDENTITY, new AbortController().signal);

		expect(result).toMatchObject({ ok: true, avatar: AVATAR_REF });
		expect(h.fetchImage).not.toHaveBeenCalled();
	});

	it("头像地址变了:抓新图并换掉状态里的两格", async () => {
		const h = setup();
		const oldRef = `${"b".repeat(64)}.webp` as ImageRef;
		h.values.set("profile:42", {
			avatarUrl: "https://i0.hdslb.com/bfs/face/old.jpg",
			avatar: oldRef,
		});
		const newRef = `${"c".repeat(64)}.webp` as ImageRef;
		h.fetchImage.mockResolvedValueOnce(ok({ ref: newRef }));

		const result = await h.fetcher.fetchProfile(IDENTITY, new AbortController().signal);

		expect(result).toMatchObject({ ok: true, avatar: newRef });
		expect(h.values.get("profile:42")).toEqual({ avatarUrl: AVATAR_URL, avatar: newRef });
	});

	it("抓不到头像时名字照交、结果不带 avatar", async () => {
		const h = setup();
		h.fetchImage.mockResolvedValueOnce(fail("unavailable", "图床不通"));

		const result = await h.fetcher.fetchProfile(IDENTITY, new AbortController().signal);

		expect(result).toMatchObject({ ok: true, name: "阿甲" });
		expect(result).not.toHaveProperty("avatar");
	});

	it("名单外的人照交资料,但不抓头像、也不写状态", async () => {
		const h = setup();
		h.roster.delete(UID);

		const result = await h.fetcher.fetchProfile(IDENTITY, new AbortController().signal);

		expect(result).toEqual(ok({ name: "阿甲", bio: "简介", followers: 123 }));
		expect(h.fetchImage).not.toHaveBeenCalled();
		expect(h.values.has("profile:42")).toBe(false);
	});

	it("状态里记了粉丝牌名时一并交回", async () => {
		const h = setup();
		h.values.set("profile:42", { fanClubName: "甲牌" });

		const result = await h.fetcher.fetchProfile(IDENTITY, new AbortController().signal);

		expect(result).toMatchObject({ ok: true, fanClubName: "甲牌" });
	});

	it("两次出网不足 200ms 时先等;等待期间 signal 中止就不出网", async () => {
		vi.useFakeTimers();
		const h = setup();
		await h.fetcher.fetchProfile(IDENTITY, new AbortController().signal);

		const controller = new AbortController();
		const second = h.fetcher.fetchProfile(IDENTITY, controller.signal);
		await Promise.resolve();
		expect(h.fetchUserCard).toHaveBeenCalledTimes(1);

		controller.abort();
		await expect(second).resolves.toMatchObject({ ok: false, code: "unavailable" });
		await vi.advanceTimersByTimeAsync(200);
		expect(h.fetchUserCard).toHaveBeenCalledTimes(1);

		const third = h.fetcher.fetchProfile(IDENTITY, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(200);
		await expect(third).resolves.toMatchObject({ ok: true });
		expect(h.fetchUserCard).toHaveBeenCalledTimes(2);
	});

	it("取卡拉请求抛错时回 unavailable、原话进 message,并记 warn", async () => {
		const h = setup();
		h.fetchUserCard.mockRejectedValueOnce(new Error("connect refused"));

		const result = await h.fetcher.fetchProfile(IDENTITY, new AbortController().signal);

		expect(result).toEqual(fail("unavailable", "connect refused"));
		expect(h.logger.warn).toHaveBeenCalled();
	});
});
