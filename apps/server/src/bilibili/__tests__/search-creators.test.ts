/**
 * B 站来源的搜人(`searchCreators`):纯数字按 UID 精确查、空间主页链接先抽 UID 再精确查、其余按名字搜
 * (ADR-0021 决策 7)。全程假 `Api`,不外连。
 */

import { type FailureCode, fail, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Api } from "../api/index.js";
import { searchBiliCreators, spaceUidOf } from "../search-creators.js";

function apiOf(over: { fetchUserCard?: unknown; searchByType?: unknown }) {
	return {
		fetchUserCard: vi.fn(async () => over.fetchUserCard),
		searchByType: vi.fn(async () => over.searchByType),
	};
}
const asApi = (api: ReturnType<typeof apiOf>) =>
	api as unknown as Pick<Api, "fetchUserCard" | "searchByType">;

const CARD = ok({
	data: { card: { mid: "123", name: "咩栗", fans: 4567, sign: "你好呀", face: "https://x/f.png" } },
});

describe("spaceUidOf —— 空间主页链接里的 UID", () => {
	it.each([
		["https://space.bilibili.com/123", "123"],
		["space.bilibili.com/456/dynamic", "456"],
		["https://space.bilibili.com/789?spm_id_from=333", "789"],
		["http://m.bilibili.com/space/321", "321"],
	])("%s → %s", (text, uid) => {
		expect(spaceUidOf(text)).toBe(uid);
	});

	it.each([
		"咩栗",
		"https://www.bilibili.com/video/BV1xx411c7mD",
		"https://notbilibili.com/space/123",
		"https://evil.example/space.bilibili.com/123",
	])("%s 不是空间主页链接 → undefined", (text) => {
		expect(spaceUidOf(text)).toBeUndefined();
	});
});

describe("searchBiliCreators", () => {
	// 验红:去掉纯数字那一支,第一条红(会拿 UID 当关键词去名字搜)。
	it("纯数字 → 按 UID 精确查(fetchUserCard),不走名字搜;候选带名字、粉丝、简介", async () => {
		const api = apiOf({ fetchUserCard: CARD });
		const out = await searchBiliCreators(asApi(api), "123");
		expect(api.fetchUserCard).toHaveBeenCalledWith("123");
		expect(api.searchByType).not.toHaveBeenCalled();
		expect(out).toEqual({
			ok: true,
			candidates: [{ externalId: "123", name: "咩栗", followers: 4567, bio: "你好呀" }],
		});
	});

	it("空间主页链接 → 先抽 UID 再精确查", async () => {
		const api = apiOf({ fetchUserCard: CARD });
		await searchBiliCreators(asApi(api), "https://space.bilibili.com/123/video");
		expect(api.fetchUserCard).toHaveBeenCalledWith("123");
		expect(api.searchByType).not.toHaveBeenCalled();
	});

	it("其余 → 按名字搜(bili_user),去掉高亮标签,最多 10 个,不抓头像", async () => {
		const result = Array.from({ length: 12 }, (_, i) => ({
			mid: 100 + i,
			uname: `咩<em class="keyword">栗</em>${i}`,
			fans: i,
			usign: "",
			upic: "//i0.hdslb.com/x.jpg",
		}));
		const api = apiOf({ searchByType: ok({ data: { result } }) });
		const out = await searchBiliCreators(asApi(api), " 咩栗 ");
		expect(api.searchByType).toHaveBeenCalledWith("bili_user", "咩栗");
		expect(api.fetchUserCard).not.toHaveBeenCalled();
		if (!out.ok) throw new Error("应当成功");
		expect(out.candidates).toHaveLength(10);
		expect(out.candidates[0]).toEqual({ externalId: "100", name: "咩栗0", followers: 0 });
	});

	// 4-15:面板搜人改走来源,候选头像也是图库引用(subscription-sources「候选头像也是图库引用」)。
	// 验红:把 searchBiliCreators 里抓头像那一步去掉,这条红。
	it("给了抓图口:候选头像缩放后抓进图库、交引用;抓不到的那个只缺头像,不拖累别人", async () => {
		const result = [
			{ mid: 1, uname: "甲", upic: "//i0.hdslb.com/bfs/face/a.jpg" },
			{ mid: 2, uname: "乙", upic: "//i0.hdslb.com/bfs/face/b.jpg" },
			{ mid: 3, uname: "丙", upic: "" },
		];
		const fetched: Array<{ url: string; headers?: Record<string, string> }> = [];
		const images = {
			images: {
				fetchImage: vi.fn(async (url: string, opts?: { headers?: Record<string, string> }) => {
					fetched.push({ url, ...(opts?.headers ? { headers: opts.headers } : {}) });
					return url.includes("/b.jpg")
						? fail("unavailable", "CDN 挂了")
						: ok({ ref: `img_${url.includes("/a.jpg") ? "a" : "x"}` as never });
				}),
			},
			logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
		};
		const out = await searchBiliCreators(
			asApi(apiOf({ searchByType: ok({ data: { result } }) })),
			"x",
			images,
		);
		if (!out.ok) throw new Error("应当成功");
		expect(out.candidates).toEqual([
			{ externalId: "1", name: "甲", avatar: "img_a" },
			{ externalId: "2", name: "乙" },
			{ externalId: "3", name: "丙" },
		]);
		// 协议相对的地址补成 https、走头像那一档缩放(抓不到不回退原图)、带站内引用头;没有地址的不抓。
		expect(fetched.map((one) => one.url).sort()).toEqual([
			expect.stringMatching(/^https:\/\/i0\.hdslb\.com\/bfs\/face\/a\.jpg@480w/),
			expect.stringMatching(/^https:\/\/i0\.hdslb\.com\/bfs\/face\/b\.jpg@480w/),
		]);
		expect(fetched[0]?.headers).toMatchObject({ Referer: "https://www.bilibili.com/" });
	});

	it("按 UID 精确查给了抓图口:那一个候选也带头像", async () => {
		const images = {
			images: { fetchImage: vi.fn(async () => ok({ ref: "img_f" as never })) },
			logger: { warn: vi.fn() } as never,
		};
		const out = await searchBiliCreators(asApi(apiOf({ fetchUserCard: CARD })), "123", images);
		expect(out).toEqual({
			ok: true,
			candidates: [
				{ externalId: "123", name: "咩栗", followers: 4567, bio: "你好呀", avatar: "img_f" },
			],
		});
	});

	it("查无此人 / 搜不到 → 成功的空数组(不是失败)", async () => {
		expect(
			await searchBiliCreators(
				asApi(
					apiOf({
						fetchUserCard: fail("not_found", "啥都木有", { upstreamCode: -404 }),
					}),
				),
				"9",
			),
		).toEqual({ ok: true, candidates: [] });
		expect(
			await searchBiliCreators(asApi(apiOf({ searchByType: ok({ data: { result: [] } }) })), "x"),
		).toEqual({ ok: true, candidates: [] });
	});

	it("空关键词 → invalid,不出网", async () => {
		const api = apiOf({});
		expect(await searchBiliCreators(asApi(api), "  ")).toMatchObject({
			ok: false,
			code: "invalid",
		});
		expect(api.fetchUserCard).not.toHaveBeenCalled();
		expect(api.searchByType).not.toHaveBeenCalled();
	});

	// 翻译在请求层;搜人只把结果里的标准码、原话与上游码带出去。
	it.each([
		[-352, "rate_limited"],
		[-412, "rate_limited"],
		[-101, "unauthorized"],
	])("请求层回 %i → %s,数字码放 upstreamCode;名字搜与精确查同一条路", async (code, standard) => {
		for (const [query, api] of [
			["x", apiOf({ searchByType: fail(standard as FailureCode, "m", { upstreamCode: code }) })],
			["5", apiOf({ fetchUserCard: fail(standard as FailureCode, "m", { upstreamCode: code }) })],
		] as const) {
			expect(await searchBiliCreators(asApi(api), query)).toMatchObject({
				ok: false,
				code: standard,
				upstreamCode: code,
			});
		}
	});

	it("请求层已有的 unknown 结果原样收下,搜人不再另记 warn", async () => {
		const out = await searchBiliCreators(
			asApi(
				apiOf({
					searchByType: fail("unknown", "怪事", { upstreamCode: -9999 }),
				}),
			),
			"x",
		);
		expect(out).toMatchObject({ ok: false, code: "unknown", upstreamCode: -9999 });
	});
});

describe("searchBiliCreators:回给人看的整句话", () => {
	it("关键词是空白:搜索关键词不能为空", async () => {
		expect(await searchBiliCreators(asApi(apiOf({})), "  ")).toMatchObject({
			message: "搜索关键词不能为空",
		});
	});

	it("B 站带了话:拼在固定的一句后面", async () => {
		const out = await searchBiliCreators(
			asApi(
				apiOf({
					searchByType: fail("rate_limited", "请求被拦截", { upstreamCode: -412 }),
				}),
			),
			"咩栗",
		);
		expect(out).toMatchObject({ message: "B 站没能完成搜索：请求被拦截" });
	});

	it("B 站没带话:只有固定的一句", async () => {
		const out = await searchBiliCreators(
			asApi(apiOf({ searchByType: fail("rate_limited", "", { upstreamCode: -412 }) })),
			"咩栗",
		);
		expect(out).toMatchObject({ message: "B 站没能完成搜索" });
	});
});
