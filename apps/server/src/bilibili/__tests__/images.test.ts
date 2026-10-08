import type { ImageRef, Logger, Post } from "@bilibili-notify/internal";
import { fail, makeEmptySubscription, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	fetchAvatar,
	fetchLiveCover,
	fetchPostImages,
	type ImagesDeps,
	scaledImageUrl,
	subscribedAvatar,
	syncProfileAvatar,
} from "../images";

const refOf = (n: number): ImageRef => `${n.toString(16).padStart(64, "0")}.jpg` as ImageRef;

function silentLogger(): Logger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/** 假的抓图服务:按地址回引用(同一地址同一引用);`failing` 里的地址回失败。记下每次调用。 */
function fakeImages(failing: (url: string) => boolean = () => false) {
	const calls: { url: string; headers?: Record<string, string> }[] = [];
	const ids = new Map<string, number>();
	const fetchImage: ImagesDeps["images"]["fetchImage"] = async (url, opts) => {
		calls.push({ url, headers: opts?.headers });
		if (failing(url)) return fail("unavailable", "连不上");
		if (!ids.has(url)) ids.set(url, ids.size + 1);
		return ok({ ref: refOf(ids.get(url) ?? 0) });
	};
	return {
		calls,
		ids,
		deps: { images: { fetchImage }, logger: silentLogger() } satisfies ImagesDeps,
	};
}

const basePost = (extra: Partial<Post> = {}): Post => ({
	creator: { name: "UP" },
	publishedAt: "2026-10-07T00:00:00.000Z",
	text: "正文",
	...extra,
});

describe("scaledImageUrl", () => {
	it("给 B 站图床的 /bfs/ 地址加缩放 + 第一帧 + webp 后缀", () => {
		expect(scaledImageUrl("https://i0.hdslb.com/bfs/new_dyn/abc.jpg")).toBe(
			"https://i0.hdslb.com/bfs/new_dyn/abc.jpg@1280w_80q_1s.webp",
		);
	});

	it("非 B 站图床的地址、静态站 s1、非 /bfs/ 路径、不是地址的串原样返回", () => {
		for (const url of [
			"https://example.com/bfs/a.jpg",
			"https://s1.hdslb.com/bfs/static/a.png",
			"https://i0.hdslb.com/other/a.jpg",
			"not a url",
		]) {
			expect(scaledImageUrl(url)).toBe(url);
		}
	});

	it("已有的 @ 处理后缀被替换,query 保留在最后", () => {
		expect(scaledImageUrl("https://i2.hdslb.com/bfs/archive/x.png@100w.webp")).toBe(
			"https://i2.hdslb.com/bfs/archive/x.png@1280w_80q_1s.webp",
		);
		expect(scaledImageUrl("https://i0.hdslb.com/bfs/a.jpg?t=1&b=2")).toBe(
			"https://i0.hdslb.com/bfs/a.jpg@1280w_80q_1s.webp?t=1&b=2",
		);
	});
});

describe("fetchPostImages", () => {
	it("图集里只有地址的图抓进图库:先抓缩放地址带 Referer,图上加 ref、url 仍是原图地址", async () => {
		const { calls, deps } = fakeImages();
		const original = "https://i0.hdslb.com/bfs/new_dyn/a.jpg";
		const post = basePost({ images: [{ url: original, width: 10, height: 20 }] });

		const result = await fetchPostImages(post, deps);

		expect(calls).toEqual([
			{ url: `${original}@1280w_80q_1s.webp`, headers: { Referer: "https://www.bilibili.com/" } },
		]);
		expect(result.images).toEqual([{ url: original, width: 10, height: 20, ref: refOf(1) }]);
	});

	it("作品里每一种放图的格子都走:专栏配图、专属锁图标、视频封面、三种附加块的封面、被转发的内层作品", async () => {
		const { deps } = fakeImages();
		const u = (name: string) => `https://i0.hdslb.com/bfs/x/${name}.jpg`;
		const post = basePost({
			article: { title: "专栏", images: [{ url: u("article") }] },
			locked: { icon: { url: u("locked") }, title: "t", hint: "h" },
			video: { cover: { url: u("video") }, title: "v", description: "d" },
			attachment: { kind: "card", title: "c", cover: { url: u("card") } },
			repost: basePost({
				images: [{ url: u("inner") }],
				attachment: {
					kind: "goods",
					items: [
						{ cover: { url: u("goods1") }, name: "a" },
						{ cover: { url: u("goods2") }, name: "b" },
					],
				},
			}),
		});
		const videoAttachment = basePost({
			attachment: { kind: "video", cover: { url: u("quoted") }, title: "q" },
		});

		const result = await fetchPostImages(post, deps);
		const quoted = await fetchPostImages(videoAttachment, deps);

		const missing = [
			result.article?.images?.[0],
			result.locked?.icon,
			result.video?.cover,
			result.attachment?.kind === "card" ? result.attachment.cover : undefined,
			result.repost?.images?.[0],
			...(result.repost?.attachment?.kind === "goods"
				? result.repost.attachment.items.map((item) => item.cover)
				: []),
			quoted.attachment?.kind === "video" ? quoted.attachment.cover : undefined,
		].filter((image) => image?.ref === undefined);
		expect(missing).toEqual([]);
	});

	it("已有引用的图不动、不抓;没有地址的图也不抓", async () => {
		const { calls, deps } = fakeImages();
		const post = basePost({
			images: [
				{ ref: refOf(99), url: "https://i0.hdslb.com/bfs/x/has-ref.jpg" },
				{ ref: refOf(98) },
				{ width: 1 },
			],
		});

		const result = await fetchPostImages(post, deps);

		expect(calls).toEqual([]);
		expect(result.images).toEqual(post.images);
	});

	it("缩放地址抓不到就再抓一次原地址;存下来的是原地址那份,图上的 url 不变", async () => {
		const original = "https://i0.hdslb.com/bfs/x/a.jpg";
		const { calls, deps } = fakeImages((url) => url.includes("@"));

		const result = await fetchPostImages(basePost({ images: [{ url: original }] }), deps);

		expect(calls.map((c) => c.url)).toEqual([`${original}@1280w_80q_1s.webp`, original]);
		expect(result.images).toEqual([{ url: original, ref: refOf(1) }]);
	});

	it("非 B 站图床的地址缩放地址与原地址相同,只抓一次", async () => {
		const url = "https://example.com/a.png";
		const { calls, deps } = fakeImages(() => true);

		await fetchPostImages(basePost({ images: [{ url }] }), deps);

		expect(calls.map((c) => c.url)).toEqual([url]);
	});

	it("两次都抓不到:这张图保持只有地址,记一条不带 query 的 warn,不抛,别的图照抓", async () => {
		const bad = "https://i0.hdslb.com/bfs/x/bad.jpg?token=secret";
		const good = "https://i0.hdslb.com/bfs/x/good.jpg";
		const { deps } = fakeImages((url) => url.includes("bad.jpg"));

		const result = await fetchPostImages(basePost({ images: [{ url: bad }, { url: good }] }), deps);

		expect(result.images?.[0]).toEqual({ url: bad });
		expect(result.images?.[1]?.ref).toBeDefined();
		const warn = vi.mocked(deps.logger.warn);
		expect(warn).toHaveBeenCalledTimes(1);
		const line = String(warn.mock.calls[0]?.[0]);
		expect(line).toContain("/bfs/x/bad.jpg");
		expect(line).not.toContain("secret");
	});

	it("抓图服务本身抛了:和抓不到一样,这张图保持只有地址、记一条不带 query 的 warn,不抛,别的图照抓", async () => {
		const bad = "https://i0.hdslb.com/bfs/x/bad.jpg?token=secret";
		const good = "https://i0.hdslb.com/bfs/x/good.jpg";
		const { deps: working } = fakeImages();
		const deps: ImagesDeps = {
			images: {
				fetchImage: async (url, opts) => {
					if (url.includes("bad.jpg")) throw new Error("socket hang up");
					return working.images.fetchImage(url, opts);
				},
			},
			logger: silentLogger(),
		};

		const result = await fetchPostImages(basePost({ images: [{ url: bad }, { url: good }] }), deps);

		expect(result.images?.[0]).toEqual({ url: bad });
		expect(result.images?.[1]?.ref).toBeDefined();
		const warn = vi.mocked(deps.logger.warn);
		expect(warn).toHaveBeenCalledTimes(1);
		const line = String(warn.mock.calls[0]?.[0]);
		expect(line).toContain("/bfs/x/bad.jpg");
		expect(line).toContain("socket hang up");
		expect(line).not.toContain("secret");
	});

	it("不改入参:原作品与它的图数组原样", async () => {
		const { deps } = fakeImages();
		const post = basePost({
			images: [{ url: "https://i0.hdslb.com/bfs/x/a.jpg" }],
			repost: basePost({ images: [{ url: "https://i0.hdslb.com/bfs/x/b.jpg" }] }),
		});
		const snapshot = structuredClone(post);

		const result = await fetchPostImages(post, deps);

		expect(post).toEqual(snapshot);
		expect(result).not.toBe(post);
		expect(result.images?.[0]).not.toBe(post.images?.[0]);
	});

	it("同时在抓的不超过 3 张", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchImage: ImagesDeps["images"]["fetchImage"] = async (url) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight--;
			return ok({ ref: refOf(url.length) });
		};
		const images = Array.from({ length: 8 }, (_, i) => ({
			url: `https://i0.hdslb.com/bfs/x/${"a".repeat(i + 1)}.jpg`,
		}));

		await fetchPostImages(basePost({ images }), { images: { fetchImage }, logger: silentLogger() });

		expect(peak).toBe(3);
	});

	it("同一个地址在一条作品里出现几次也只抓一次,每处都拿到引用", async () => {
		const { calls, deps } = fakeImages();
		const url = "https://i0.hdslb.com/bfs/x/same.jpg";
		const post = basePost({
			images: [{ url }],
			video: { cover: { url }, title: "v", description: "d" },
		});

		const result = await fetchPostImages(post, deps);

		expect(calls).toHaveLength(1);
		expect(result.images?.[0]?.ref).toBe(result.video?.cover.ref);
	});
});

describe("fetchPostImages 的头像", () => {
	it("外层作者的头像引用填进 creator.avatar,零网络;别的格子不动", async () => {
		const { calls, deps } = fakeImages();
		const post = basePost({ creator: { name: "UP", isPremium: true } });

		const result = await fetchPostImages(post, deps, { avatar: refOf(70) });

		expect(calls).toEqual([]);
		expect(result.creator).toEqual({ name: "UP", isPremium: true, avatar: refOf(70) });
		expect(post.creator).toEqual({ name: "UP", isPremium: true });
	});
});

describe("fetchPostImages 的转发原作者头像", () => {
	const faceUrl = "https://i0.hdslb.com/bfs/face/orig.jpg";
	const repostPost = () => basePost({ repost: basePost({ creator: { name: "原作者" } }) });

	it("按头像地址现抓(头像那一档 480 宽、带 Referer),填进 repost.creator.avatar", async () => {
		const { calls, deps } = fakeImages();

		const result = await fetchPostImages(repostPost(), deps, { repostAvatarUrl: faceUrl });

		expect(calls).toEqual([
			{ url: `${faceUrl}@480w_80q_1s.webp`, headers: { Referer: "https://www.bilibili.com/" } },
		]);
		expect(result.repost?.creator).toEqual({ name: "原作者", avatar: refOf(1) });
		expect(result.creator.avatar).toBeUndefined();
	});

	it("抓不到:内层没有头像、不回退原图,配图照抓,不抛", async () => {
		const img = "https://i0.hdslb.com/bfs/x/a.jpg";
		const { calls, deps } = fakeImages((url) => url.includes("orig.jpg"));
		const post = basePost({
			images: [{ url: img }],
			repost: basePost({ creator: { name: "原作者" } }),
		});

		const result = await fetchPostImages(post, deps, { repostAvatarUrl: faceUrl });

		expect(calls.filter((c) => c.url.includes("orig.jpg"))).toHaveLength(1);
		expect(result.repost?.creator).toEqual({ name: "原作者" });
		expect(result.images?.[0]?.ref).toBeDefined();
	});

	it("作品不是转发就没有地方放,头像地址不抓", async () => {
		const { calls, deps } = fakeImages();

		await fetchPostImages(basePost(), deps, { repostAvatarUrl: faceUrl });

		expect(calls).toEqual([]);
	});

	it("和配图共用同一个并发上限:同时在抓的仍不超过 3 张", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchImage: ImagesDeps["images"]["fetchImage"] = async (url) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight--;
			return ok({ ref: refOf(url.length) });
		};
		const images = Array.from({ length: 6 }, (_, i) => ({
			url: `https://i0.hdslb.com/bfs/x/${"a".repeat(i + 1)}.jpg`,
		}));
		const post = basePost({ images, repost: basePost({ creator: { name: "原作者" } }) });

		await fetchPostImages(
			post,
			{ images: { fetchImage }, logger: silentLogger() },
			{
				repostAvatarUrl: faceUrl,
			},
		);

		expect(peak).toBe(3);
	});
});

describe("fetchPostImages 的表情图", () => {
	const doge = "https://i0.hdslb.com/bfs/emote/doge.png";
	const emojiUrls = new Map([["[doge]", doge]]);
	const postWithEmoji = (extra: Partial<Post> = {}): Post =>
		basePost({
			text: "看[doge]",
			richText: [
				{ kind: "text", text: "看" },
				{ kind: "emoji", text: "[doge]" },
			],
			...extra,
		});

	it("表情节点按文字查地址:抓 128 宽第一帧的缩放版、带 Referer,图库引用填进 image", async () => {
		const { calls, deps } = fakeImages();

		const result = await fetchPostImages(postWithEmoji(), deps, { emojiUrls });

		expect(calls).toEqual([
			{ url: `${doge}@128w_80q_1s.webp`, headers: { Referer: "https://www.bilibili.com/" } },
		]);
		expect(result.richText).toEqual([
			{ kind: "text", text: "看" },
			{ kind: "emoji", text: "[doge]", image: refOf(1) },
		]);
	});

	it("同一个表情出现几次(外层、转发内层)只抓一次,每处都拿到引用", async () => {
		const { calls, deps } = fakeImages();
		const post = postWithEmoji({
			richText: [
				{ kind: "emoji", text: "[doge]" },
				{ kind: "emoji", text: "[doge]" },
			],
			repost: basePost({ richText: [{ kind: "emoji", text: "[doge]" }] }),
		});

		const result = await fetchPostImages(post, deps, { emojiUrls });

		expect(calls).toHaveLength(1);
		const refs = [...(result.richText ?? []), ...(result.repost?.richText ?? [])].map((segment) =>
			segment.kind === "emoji" ? segment.image : undefined,
		);
		expect(refs).toEqual([refOf(1), refOf(1), refOf(1)]);
	});

	it("转发内层的表情也填", async () => {
		const { calls, deps } = fakeImages();
		const post = basePost({
			repost: basePost({ richText: [{ kind: "emoji", text: "[doge]" }], text: "[doge]" }),
		});

		const result = await fetchPostImages(post, deps, { emojiUrls });

		expect(calls).toHaveLength(1);
		expect(result.repost?.richText).toEqual([{ kind: "emoji", text: "[doge]", image: refOf(1) }]);
	});

	it("已有 image 的表情不动、不抓;表里没有地址的表情保持文字,别的片段原样", async () => {
		const { calls, deps } = fakeImages();
		const kept = refOf(99);
		const post = basePost({
			text: "[doge][other]@甲",
			richText: [
				{ kind: "emoji", text: "[doge]", image: kept },
				{ kind: "emoji", text: "[other]" },
				{ kind: "mention", text: "@甲", userId: "1" },
			],
		});

		const result = await fetchPostImages(post, deps, { emojiUrls });

		expect(calls).toEqual([]);
		expect(result.richText).toEqual(post.richText);
	});

	it("同一个表情文字,有 image 的那个不被换掉、没有的那个照填", async () => {
		const { calls, deps } = fakeImages();
		const kept = refOf(99);
		const post = basePost({
			text: "[doge][doge]",
			richText: [
				{ kind: "emoji", text: "[doge]", image: kept },
				{ kind: "emoji", text: "[doge]" },
			],
		});

		const result = await fetchPostImages(post, deps, { emojiUrls });

		expect(calls).toHaveLength(1);
		expect(result.richText).toEqual([
			{ kind: "emoji", text: "[doge]", image: kept },
			{ kind: "emoji", text: "[doge]", image: refOf(1) },
		]);
	});

	it("不给 emojiUrls:表情节点原样,一张都不抓", async () => {
		const { calls, deps } = fakeImages();

		const result = await fetchPostImages(postWithEmoji(), deps);

		expect(calls).toEqual([]);
		expect(result.richText).toEqual(postWithEmoji().richText);
	});

	it("抓不到:那个表情保持文字、不回退原图、不抛,warn 不带 query;别的表情与配图照抓", async () => {
		const bad = "https://i0.hdslb.com/bfs/emote/bad.png?token=secret";
		const { calls, deps } = fakeImages((url) => url.includes("bad.png"));
		const post = postWithEmoji({
			images: [{ url: "https://i0.hdslb.com/bfs/x/a.jpg" }],
			richText: [
				{ kind: "emoji", text: "[bad]" },
				{ kind: "emoji", text: "[doge]" },
			],
		});

		const result = await fetchPostImages(post, deps, {
			emojiUrls: new Map([...emojiUrls, ["[bad]", bad]]),
		});

		expect(calls.filter((c) => c.url.includes("bad.png"))).toEqual([
			{
				url: "https://i0.hdslb.com/bfs/emote/bad.png@128w_80q_1s.webp?token=secret",
				headers: { Referer: "https://www.bilibili.com/" },
			},
		]);
		expect(result.richText).toEqual([
			{ kind: "emoji", text: "[bad]" },
			{ kind: "emoji", text: "[doge]", image: expect.any(String) },
		]);
		expect(result.images?.[0]?.ref).toBeDefined();
		const warns = vi.mocked(deps.logger.warn).mock.calls.map((call) => String(call[0]));
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("https://i0.hdslb.com/bfs/emote/bad.png");
		expect(warns[0]).not.toContain("token");
		expect(warns[0]).not.toContain("secret");
	});

	it("抓图服务本身抛了:表情保持文字、不抛", async () => {
		const deps: ImagesDeps = {
			images: {
				fetchImage: async () => {
					throw new Error("炸了");
				},
			},
			logger: silentLogger(),
		};

		const result = await fetchPostImages(postWithEmoji(), deps, { emojiUrls });

		expect(vi.mocked(deps.logger.warn)).toHaveBeenCalledTimes(1);
		expect(result.richText).toEqual(postWithEmoji().richText);
	});

	it("不改入参:原作品的 richText 数组与片段原样", async () => {
		const { calls, deps } = fakeImages();
		const post = postWithEmoji({
			repost: basePost({ richText: [{ kind: "emoji", text: "[doge]" }] }),
		});
		const before = structuredClone(post);

		await fetchPostImages(post, deps, { emojiUrls });

		expect(calls).toHaveLength(1);
		expect(post).toEqual(before);
	});

	it("和配图、头像共用同一个并发上限:同时在抓的仍不超过 3 张", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchImage: ImagesDeps["images"]["fetchImage"] = async (url) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight--;
			return ok({ ref: refOf(url.length) });
		};
		const codes = Array.from({ length: 6 }, (_, i) => `[e${"x".repeat(i)}]`);
		const post = basePost({
			images: Array.from({ length: 3 }, (_, i) => ({
				url: `https://i0.hdslb.com/bfs/x/${"a".repeat(i + 1)}.jpg`,
			})),
			richText: codes.map((text) => ({ kind: "emoji" as const, text })),
			text: codes.join(""),
			repost: basePost({ creator: { name: "原作者" } }),
		});

		await fetchPostImages(
			post,
			{ images: { fetchImage }, logger: silentLogger() },
			{
				repostAvatarUrl: "https://i0.hdslb.com/bfs/face/orig.jpg",
				emojiUrls: new Map(
					codes.map((code) => [code, `https://i0.hdslb.com/bfs/emote/${code.length}.png`]),
				),
			},
		);

		expect(peak).toBe(3);
	});
});

describe("fetchLiveCover", () => {
	const input = (cover?: { url?: string; ref?: ImageRef }) => ({
		status: "start" as const,
		creator: { name: "UP" },
		...(cover ? { cover } : {}),
	});

	it("封面只有地址就抓进图库:图上加 ref、保留原 url,别的格子原样,不改入参", async () => {
		const { calls, deps } = fakeImages();
		const url = "https://i0.hdslb.com/bfs/live/cover.jpg";
		const original = input({ url });

		const result = await fetchLiveCover(original, deps);

		expect(calls[0]?.url).toBe(`${url}@1280w_80q_1s.webp`);
		expect(result).toEqual({ ...original, cover: { url, ref: refOf(1) } });
		expect(original.cover).toEqual({ url });
	});

	it("没有封面、或封面已有引用:不抓", async () => {
		const { calls, deps } = fakeImages();

		const noCover = await fetchLiveCover(input(), deps);
		const hasRef = await fetchLiveCover(input({ ref: refOf(5), url: "https://x/y.jpg" }), deps);

		expect(calls).toEqual([]);
		expect(noCover.cover).toBeUndefined();
		expect(hasRef.cover?.ref).toBe(refOf(5));
	});

	it("封面抓不到:保持只有地址,记 warn,不抛", async () => {
		const { deps } = fakeImages(() => true);
		const url = "https://i0.hdslb.com/bfs/live/cover.jpg";

		const result = await fetchLiveCover(input({ url }), deps);

		expect(result.cover).toEqual({ url });
		expect(deps.logger.warn).toHaveBeenCalledTimes(1);
	});
});

describe("fetchAvatar", () => {
	const face = "https://i1.hdslb.com/bfs/face/abc.jpg";

	// 验红:去掉 fetchAvatar 里的 try/catch,这条红(抓图服务抛了就直接抛给调用方)。
	it("抓图服务本身抛了 → 回 undefined、记一条不带 query 的 warn,不抛", async () => {
		const deps: ImagesDeps = {
			images: {
				fetchImage: async () => {
					throw new Error("boom");
				},
			},
			logger: silentLogger(),
		};
		await expect(fetchAvatar(`${face}?token=secret`, deps)).resolves.toBeUndefined();
		const line = String(vi.mocked(deps.logger.warn).mock.calls[0]?.[0]);
		expect(line).toContain("boom");
		expect(line).not.toContain("secret");
	});

	it("抓 480 宽、第一帧、webp 的缩放版,带站内引用头,回图库引用", async () => {
		const { deps, calls } = fakeImages();
		const ref = await fetchAvatar(face, deps);
		expect(calls).toEqual([
			{
				url: "https://i1.hdslb.com/bfs/face/abc.jpg@480w_80q_1s.webp",
				headers: { Referer: "https://www.bilibili.com/" },
			},
		]);
		expect(ref).toBe(refOf(1));
	});

	it("缩放版抓不到不回退原图:只调一次、回 undefined、不抛", async () => {
		const { deps, calls } = fakeImages(() => true);
		expect(await fetchAvatar(face, deps)).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	it("抓不到记的 warn 带地址但不带 query", async () => {
		const { deps } = fakeImages(() => true);
		await fetchAvatar(`${face}?token=secret`, deps);
		const warned = vi.mocked(deps.logger.warn).mock.calls.flat().join("\n");
		expect(warned).toContain(face);
		expect(warned).not.toContain("secret");
	});

	it("非 B 站图床的地址只抓一次原地址", async () => {
		const { deps, calls } = fakeImages();
		const url = "https://example.com/a.png";
		expect(await fetchAvatar(url, deps)).toBe(refOf(1));
		expect(calls.map((call) => call.url)).toEqual([url]);
	});
});

describe("syncProfileAvatar", () => {
	const face = "https://i1.hdslb.com/bfs/face/abc.jpg";
	const newFace = "https://i2.hdslb.com/bfs/face/new.jpg";
	const oldRef = refOf(99);

	it("资料里没有头像:抓到就 avatar 与 avatarUrl(原样来源地址,不是缩放后的)一起记", async () => {
		const { deps } = fakeImages();
		expect(await syncProfileAvatar(undefined, face, deps)).toEqual({
			avatar: refOf(1),
			avatarUrl: face,
		});
	});

	it("地址没变且已有 avatar:零网络、原样返回", async () => {
		const { deps, calls } = fakeImages();
		const current = { avatar: oldRef, avatarUrl: face };
		expect(await syncProfileAvatar(current, face, deps)).toEqual(current);
		expect(calls).toHaveLength(0);
	});

	it("有地址却没有 avatar:再抓一次", async () => {
		const { deps, calls } = fakeImages();
		expect(await syncProfileAvatar({ avatarUrl: face }, face, deps)).toEqual({
			avatar: refOf(1),
			avatarUrl: face,
		});
		expect(calls).toHaveLength(1);
	});

	it("地址变了且抓到:两格一起换成新的", async () => {
		const { deps } = fakeImages();
		expect(await syncProfileAvatar({ avatar: oldRef, avatarUrl: face }, newFace, deps)).toEqual({
			avatar: refOf(1),
			avatarUrl: newFace,
		});
	});

	it("抓不到、原本没有 avatar:avatarUrl 记新地址、avatar 缺键", async () => {
		const { deps } = fakeImages(() => true);
		const result = await syncProfileAvatar(undefined, face, deps);
		expect(result).toEqual({ avatarUrl: face });
		expect("avatar" in result).toBe(false);
	});

	it("抓不到、原本有 avatar:两格保持原样,下一轮地址仍不同、真的又去抓", async () => {
		let down = true;
		const { deps, calls } = fakeImages(() => down);
		const current = { avatar: oldRef, avatarUrl: face };
		const first = await syncProfileAvatar(current, newFace, deps);
		expect(first).toEqual(current);
		expect(calls).toHaveLength(1);
		down = false;
		const second = await syncProfileAvatar(first, newFace, deps);
		expect(calls).toHaveLength(2);
		expect(second).toEqual({ avatar: refOf(1), avatarUrl: newFace });
	});

	it("B 站没给地址:原样返回,不抓", async () => {
		const { deps, calls } = fakeImages();
		const current = { avatar: oldRef, avatarUrl: face };
		expect(await syncProfileAvatar(current, undefined, deps)).toEqual(current);
		expect(await syncProfileAvatar(undefined, "", deps)).toEqual({});
		expect(calls).toHaveLength(0);
	});
});

describe("subscribedAvatar", () => {
	const subscription = (id: string, sourceKey: string, externalId: string) =>
		makeEmptySubscription({ id, identity: { sourceKey, externalId } });
	const profiles: Record<string, { avatar?: ImageRef }> = { "sub-b": { avatar: refOf(5) } };
	const profileOf = (id: string) => profiles[id];

	it("按 uid 找已订阅的 B 站 UP,回资料里的头像引用", () => {
		const subs = [subscription("sub-b", "bilibili", "123")];
		expect(subscribedAvatar(subs, profileOf, "123")).toBe(refOf(5));
	});

	it("没订阅、资料里没有头像、或者只是别的来源里碰巧同号的外部 id:都回 undefined", () => {
		const subs = [
			subscription("sub-x", "other-source", "456"),
			subscription("sub-n", "bilibili", "789"),
		];
		expect(subscribedAvatar(subs, profileOf, "123")).toBeUndefined();
		expect(subscribedAvatar(subs, profileOf, "456")).toBeUndefined();
		expect(subscribedAvatar(subs, profileOf, "789")).toBeUndefined();
	});
});
