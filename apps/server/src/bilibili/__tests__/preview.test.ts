/**
 * B 站来源的作品卡预览(`Source.fetchPreview` 的作品那一支,4-14):取这个人 space 动态列表里的第 `nth` 条,
 * 与真推送同一套翻译与抓图,交 `{ kind: "post", report }`。失败回结果形状,原话会显示在面板上。
 * 替身只换 B 站接口与抓图口,不联网。
 */

import { fail, type Identity, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { previewBiliPost } from "../preview.js";

const IDENTITY: Identity = { sourceKey: "bilibili", externalId: "999" };
const IMAGE_REF = `${"a".repeat(64)}.png`;

/** 一条纯文字动态。 */
function wordItem(id: string, text: string) {
	return {
		basic: {},
		id_str: id,
		type: "DYNAMIC_TYPE_WORD",
		modules: {
			module_author: { name: "真实UP", pub_ts: 1_700_000_000, vip: { type: 0 } },
			module_dynamic: {
				desc: {
					text,
					rich_text_nodes: [{ type: "RICH_TEXT_NODE_TYPE_TEXT", orig_text: text, text }],
				},
			},
		},
	};
}

function depsOf(feed: () => Promise<unknown>) {
	const fetchImage = vi.fn(async () => ok({ ref: IMAGE_REF }));
	return {
		api: { fetchUserSpaceDynamic: vi.fn(feed) },
		images: { fetchImage },
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	};
}

const signal = new AbortController().signal;

describe("previewBiliPost", () => {
	it("取 space 列表里的第 nth 条(1 是最新那条),翻成中立作品,链接是动态页", async () => {
		const deps = depsOf(async () => ({
			code: 0,
			data: { items: [wordItem("1", "第一条"), wordItem("2", "第二条")] },
		}));
		const result = await previewBiliPost(IDENTITY, 2, deps, signal);
		expect(deps.api.fetchUserSpaceDynamic).toHaveBeenCalledWith("999");
		expect(result).toMatchObject({
			ok: true,
			kind: "post",
			report: {
				postId: "2",
				url: "https://t.bilibili.com/2",
				post: { creator: { name: "真实UP" } },
			},
		});
		if (!result.ok || result.kind !== "post") throw new Error("应是作品那一支");
		expect(JSON.stringify(result.report.post)).toContain("第二条");
	});

	it("列表是空的 → not_found,话是给人看的", async () => {
		const deps = depsOf(async () => ({ code: 0, data: { items: [] } }));
		await expect(previewBiliPost(IDENTITY, 1, deps, signal)).resolves.toEqual({
			ok: false,
			code: "not_found",
			message: "这位创作者还没有作品",
		});
	});

	it("第 nth 条超出列表 → not_found,说清只有几条", async () => {
		const deps = depsOf(async () => ({ code: 0, data: { items: [wordItem("1", "只有一条")] } }));
		await expect(previewBiliPost(IDENTITY, 3, deps, signal)).resolves.toEqual({
			ok: false,
			code: "not_found",
			message: "只有 1 条作品，没有第 3 条",
		});
	});

	it("B 站回了非 0 的码 → 照码表翻成标准码,原话与数字码都带着", async () => {
		const deps = depsOf(async () => ({ code: -352, message: "风控校验失败" }));
		await expect(previewBiliPost(IDENTITY, 1, deps, signal)).resolves.toEqual(
			fail("rate_limited", "风控校验失败", { upstreamCode: -352 }),
		);
	});

	it("请求抛了(网络) → unavailable,原话照给", async () => {
		const deps = depsOf(async () => {
			throw new Error("network down");
		});
		await expect(previewBiliPost(IDENTITY, 1, deps, signal)).resolves.toEqual({
			ok: false,
			code: "unavailable",
			message: "network down",
		});
	});
});
