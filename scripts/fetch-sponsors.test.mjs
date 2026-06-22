import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	avatarToDataUri,
	buildRequestBody,
	buildSponsorsFile,
	extractSponsors,
	fetchAllSponsors,
	fetchAvatar,
	localizeSponsors,
	signRequest,
} from "./fetch-sponsors.mjs";

describe("signRequest", () => {
	it("matches afdian's documented md5(token+params+ts+user_id) concatenation", () => {
		// 文档示例:sign = md5('123' + 'params' + '{"a":333}' + 'ts' + '1624339905' + 'user_id' + 'abc')
		const expected = createHash("md5")
			.update('123params{"a":333}ts1624339905user_idabc')
			.digest("hex");
		expect(signRequest("123", '{"a":333}', 1624339905, "abc")).toBe(expected);
	});
});

describe("buildRequestBody", () => {
	it("puts page into params and signs the request", () => {
		const body = buildRequestBody({ userId: "abc", token: "123", page: 2, ts: 1624339905 });
		expect(body.user_id).toBe("abc");
		expect(body.params).toBe('{"page":2}');
		expect(body.ts).toBe(1624339905);
		expect(body.sign).toBe(signRequest("123", '{"page":2}', 1624339905, "abc"));
	});
});

describe("extractSponsors", () => {
	it("collects unique sponsors (name + avatar) preserving first-seen order", () => {
		const responses = [
			{
				data: {
					list: [
						{ user: { name: "Alice", avatar: "https://cdn/a.png" } },
						{ user: { name: "Bob", avatar: "https://cdn/b.png" } },
					],
				},
			},
			{
				data: {
					list: [
						{ user: { name: "Bob", avatar: "https://cdn/b2.png" } }, // 重复 name → 跳过
						{ user: { name: "  ", avatar: "x" } }, // 空 name → 跳过
						{ user: { name: "Carol", avatar: "" } }, // 无头像 → avatar ""
					],
				},
			},
		];
		expect(extractSponsors(responses)).toEqual([
			{ name: "Alice", avatar: "https://cdn/a.png" },
			{ name: "Bob", avatar: "https://cdn/b.png" },
			{ name: "Carol", avatar: "" },
		]);
	});

	it("tolerates missing data / list / user gracefully", () => {
		expect(extractSponsors([{}, { data: {} }, { data: { list: [{}] } }])).toEqual([]);
	});
});

describe("fetchAllSponsors", () => {
	it("walks every page using total_page", async () => {
		const pages = {
			1: { ec: 200, data: { total_page: 2, list: [{ user: { name: "Alice", avatar: "a" } }] } },
			2: { ec: 200, data: { total_page: 2, list: [{ user: { name: "Bob", avatar: "b" } }] } },
		};
		const calls = [];
		const fetchImpl = vi.fn(async (url, init) => {
			expect(url).toBe("https://afdian.com/api/open/query-sponsor");
			const page = JSON.parse(JSON.parse(init.body).params).page;
			calls.push(page);
			return { json: async () => pages[page] };
		});
		const responses = await fetchAllSponsors({ userId: "u", token: "t", fetchImpl });
		expect(calls).toEqual([1, 2]);
		expect(extractSponsors(responses)).toEqual([
			{ name: "Alice", avatar: "a" },
			{ name: "Bob", avatar: "b" },
		]);
	});

	it("throws when afdian returns a non-200 ec", async () => {
		const fetchImpl = vi.fn(async () => ({ json: async () => ({ ec: 400, em: "bad sign" }) }));
		await expect(fetchAllSponsors({ userId: "u", token: "t", fetchImpl })).rejects.toThrow(
			/bad sign/,
		);
	});
});

describe("buildSponsorsFile", () => {
	it("wraps sponsors with no volatile timestamp (stable output across runs)", () => {
		const file = buildSponsorsFile([{ name: "Alice", avatar: "a" }]);
		expect(file).toEqual({
			sponsors: [{ name: "Alice", avatar: "a" }],
		});
	});
});

describe("avatarToDataUri", () => {
	it("encodes bytes as a base64 data URI with the content type", () => {
		const bytes = new TextEncoder().encode("hello").buffer;
		expect(avatarToDataUri(bytes, "image/png")).toBe(
			`data:image/png;base64,${Buffer.from("hello").toString("base64")}`,
		);
	});
});

describe("fetchAvatar", () => {
	it("downloads an avatar into a data URI", async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			headers: { get: () => "image/jpeg" },
			arrayBuffer: async () => new TextEncoder().encode("img").buffer,
		}));
		expect(await fetchAvatar({ url: "https://cdn/a.jpg", fetchImpl })).toBe(
			`data:image/jpeg;base64,${Buffer.from("img").toString("base64")}`,
		);
	});

	it("returns empty string on empty url, non-ok response, or network error", async () => {
		expect(await fetchAvatar({ url: "", fetchImpl: vi.fn() })).toBe("");

		const notOk = vi.fn(async () => ({
			ok: false,
			headers: { get: () => null },
			arrayBuffer: async () => new ArrayBuffer(0),
		}));
		expect(await fetchAvatar({ url: "https://cdn/x", fetchImpl: notOk })).toBe("");

		const throwing = vi.fn(async () => {
			throw new Error("net down");
		});
		expect(await fetchAvatar({ url: "https://cdn/y", fetchImpl: throwing })).toBe("");
	});

	it("defaults content type to image/jpeg when the header is missing", async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			headers: { get: () => null },
			arrayBuffer: async () => new TextEncoder().encode("z").buffer,
		}));
		expect(await fetchAvatar({ url: "https://cdn/z", fetchImpl })).toBe(
			`data:image/jpeg;base64,${Buffer.from("z").toString("base64")}`,
		);
	});
});

describe("localizeSponsors", () => {
	it("replaces each avatar url with a downloaded data URI, blanking failures", async () => {
		const fetchImpl = vi.fn(async (url) => {
			if (url === "https://cdn/a.png") {
				return {
					ok: true,
					headers: { get: () => "image/png" },
					arrayBuffer: async () => new TextEncoder().encode("A").buffer,
				};
			}
			throw new Error("404");
		});
		const sponsors = [
			{ name: "Alice", avatar: "https://cdn/a.png" },
			{ name: "Bob", avatar: "https://cdn/b.png" },
		];
		expect(await localizeSponsors(sponsors, fetchImpl)).toEqual([
			{ name: "Alice", avatar: `data:image/png;base64,${Buffer.from("A").toString("base64")}` },
			{ name: "Bob", avatar: "" },
		]);
	});
});
