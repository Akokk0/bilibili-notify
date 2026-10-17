/**
 * B 站来源的搜人(`searchCreators`):纯数字按 UID 精确查、空间主页链接先抽 UID 再精确查、其余按名字搜
 * (ADR-0021 决策 7)。全程假 `Api`,不外连。
 */

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

const CARD = {
	code: 0,
	data: { card: { mid: "123", name: "咩栗", fans: 4567, sign: "你好呀", face: "https://x/f.png" } },
};

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
		const api = apiOf({ searchByType: { code: 0, data: { result } } });
		const out = await searchBiliCreators(asApi(api), " 咩栗 ");
		expect(api.searchByType).toHaveBeenCalledWith("bili_user", "咩栗");
		expect(api.fetchUserCard).not.toHaveBeenCalled();
		if (!out.ok) throw new Error("应当成功");
		expect(out.candidates).toHaveLength(10);
		expect(out.candidates[0]).toEqual({ externalId: "100", name: "咩栗0", followers: 0 });
	});

	it("查无此人 / 搜不到 → 成功的空数组(不是失败)", async () => {
		expect(
			await searchBiliCreators(
				asApi(apiOf({ fetchUserCard: { code: -404, message: "啥都木有" } })),
				"9",
			),
		).toEqual({ ok: true, candidates: [] });
		expect(
			await searchBiliCreators(
				asApi(apiOf({ searchByType: { code: 0, data: { result: [] } } })),
				"x",
			),
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

	// 验红:去掉数字码翻译,三条红(都变成 unknown)。
	it.each([
		[-352, "rate_limited"],
		[-412, "rate_limited"],
		[-101, "unauthorized"],
	])("B 站回 %i → %s,数字码放 upstreamCode;名字搜与精确查同一张表", async (code, standard) => {
		for (const [query, api] of [
			["x", apiOf({ searchByType: { code, message: "m" } })],
			["5", apiOf({ fetchUserCard: { code, message: "m" } })],
		] as const) {
			expect(await searchBiliCreators(asApi(api), query)).toMatchObject({
				ok: false,
				code: standard,
				upstreamCode: code,
			});
		}
	});

	it("没对照的码 → unknown,码放 upstreamCode,并记一笔 warn", async () => {
		const warn = vi.fn();
		const out = await searchBiliCreators(
			asApi(apiOf({ searchByType: { code: -9999, message: "怪事" } })),
			"x",
			warn,
		);
		expect(out).toMatchObject({ ok: false, code: "unknown", upstreamCode: -9999 });
		expect(warn).toHaveBeenCalledTimes(1);
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
			asApi(apiOf({ searchByType: { code: -412, message: "请求被拦截" } })),
			"咩栗",
		);
		expect(out).toMatchObject({ message: "B 站没能完成搜索：请求被拦截" });
	});

	it("B 站没带话:只有固定的一句", async () => {
		const out = await searchBiliCreators(asApi(apiOf({ searchByType: { code: -412 } })), "咩栗");
		expect(out).toMatchObject({ message: "B 站没能完成搜索" });
	});
});
