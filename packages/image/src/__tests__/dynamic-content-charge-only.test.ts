/**
 * 充电专属动态(is_only_fans)渲染 —— 未充电时 B 站接口把
 * modules.module_dynamic 整体清空(desc/major/topic/additional 全 null),
 * `buildDynamicNode` 此前无特判,直接落进各 DYNAMIC_TYPE_* 分支渲染出空白正文。
 * 现在改为渲染一条「充电专属」占位提示,不再留白。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, h } from "vue";
import { buildDynamicNode } from "../templates/dynamic-content";
import type { Dynamic } from "../types";

const fmt = { time: () => "刚刚", num: (n: number) => String(n) };

function makeAuthor(over: Partial<Dynamic["modules"]["module_author"]> = {}) {
	return {
		avatar: {},
		face: "face.jpg",
		face_nft: false,
		following: false,
		jump_url: "",
		label: "",
		mid: 1,
		name: "示例UP",
		pub_action: "",
		pub_action_text: "",
		pub_location_text: "",
		pub_time: "刚刚",
		pub_ts: 0,
		type: "AUTHOR_TYPE_NORMAL",
		vip: { type: 0 },
		...over,
	} as Dynamic["modules"]["module_author"];
}

function makeStat() {
	return { forward: { count: 0 }, comment: { count: 0 }, like: { count: 0 } };
}

function textNodes(text: string): Dynamic["modules"]["module_dynamic"]["desc"] {
	return {
		text,
		rich_text_nodes: [{ type: "RICH_TEXT_NODE_TYPE_TEXT", orig_text: text, text }],
	} as Dynamic["modules"]["module_dynamic"]["desc"];
}

async function bodyHtml(node: Awaited<ReturnType<typeof buildDynamicNode>>): Promise<string> {
	const app = createSSRApp({ render: () => h("div", [node.body]) });
	return renderToString(app);
}

describe("buildDynamicNode — 充电专属动态(is_only_fans)", () => {
	it("充电专属且未充电(module_dynamic 全空)→ 渲染专属占位提示,不留空白", async () => {
		const dynamic: Dynamic = {
			basic: { is_only_fans: true },
			id_str: "1",
			type: "DYNAMIC_TYPE_DRAW",
			visible: true,
			modules: {
				module_author: makeAuthor({
					icon_badge: { text: "充电专属", icon: "https://example.com/badge.png" },
				}),
				module_dynamic: {
					desc: undefined,
					major: undefined,
					topic: undefined,
					additional: undefined,
				},
				module_stat: makeStat(),
			},
		};
		const node = await buildDynamicNode(dynamic, false, fmt);
		const html = await bodyHtml(node);
		expect(html).toContain("充电专属");
		expect(html.replace(/<[^>]+>/g, "").trim()).not.toBe("");
	});

	it("充电专属但已充电(module_dynamic 有真实内容)→ 正常渲染,不触发占位", async () => {
		const dynamic: Dynamic = {
			basic: { is_only_fans: true },
			id_str: "2",
			type: "DYNAMIC_TYPE_WORD",
			visible: true,
			modules: {
				module_author: makeAuthor(),
				module_dynamic: {
					desc: textNodes("这是充电专属正文"),
				},
				module_stat: makeStat(),
			},
		};
		const node = await buildDynamicNode(dynamic, false, fmt);
		const html = await bodyHtml(node);
		expect(html).toContain("这是充电专属正文");
		expect(html).not.toContain("充电专属内容");
	});

	it("非充电专属的普通动态 → 不受影响,正常渲染", async () => {
		const dynamic: Dynamic = {
			basic: {},
			id_str: "3",
			type: "DYNAMIC_TYPE_WORD",
			visible: true,
			modules: {
				module_author: makeAuthor(),
				module_dynamic: {
					desc: textNodes("普通动态正文"),
				},
				module_stat: makeStat(),
			},
		};
		const node = await buildDynamicNode(dynamic, false, fmt);
		const html = await bodyHtml(node);
		expect(html).toContain("普通动态正文");
	});

	it("转发了别人的充电专属动态(orig 未充电)→ 内部转发节点也渲染占位,不留空白", async () => {
		const lockedOrig: Dynamic = {
			basic: { is_only_fans: true },
			id_str: "5",
			type: "DYNAMIC_TYPE_DRAW",
			visible: true,
			modules: {
				module_author: makeAuthor({ name: "原作者" }),
				module_dynamic: {
					desc: undefined,
					major: undefined,
					topic: undefined,
					additional: undefined,
				},
				module_stat: makeStat(),
			},
		};
		const forward: Dynamic = {
			basic: {},
			id_str: "4",
			type: "DYNAMIC_TYPE_FORWARD",
			visible: true,
			orig: lockedOrig,
			modules: {
				module_author: makeAuthor({ name: "转发者" }),
				module_dynamic: {
					desc: textNodes("转发说的话"),
				},
				module_stat: makeStat(),
			},
		};
		const node = await buildDynamicNode(forward, false, fmt);
		expect(node.forward).toBeDefined();
		const html = await bodyHtml(node.forward as Awaited<ReturnType<typeof buildDynamicNode>>);
		expect(html).toContain("充电专属");
		expect(html.replace(/<[^>]+>/g, "").trim()).not.toBe("");
	});
});
