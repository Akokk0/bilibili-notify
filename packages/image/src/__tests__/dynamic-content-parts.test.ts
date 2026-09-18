/**
 * 动态呈现态的「文字」「媒体」两个字段(ADR-0014 决策 8 的 2026-09-18 🔗)。
 *
 * `node.body` 是构建时就把正文文字与主媒体(视频卡 / 图廊)粘成的一个 VNode,进 `content`
 * 复合块;原子块要把这两样分开摆,所以呈现态另给两份:`text` 只装文字,`media` 只装视频卡
 * 或图廊。这里钉的是每类动态的两份各自装着什么、挂点跟着部件走、没有的那份是空的。
 *
 * `body` 一个字节不变**不在这里钉** —— 23 份基准快照(`card-baseline.test.ts`)与皮肤验收门
 * 的块内层字节门(`skin/__tests__/skin-gate.test.ts`)钉着,那两份全绿就是证明。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, isVNode, type VNode } from "vue";
import * as ICONS from "../icons";
import { buildDynamicNode, type DynamicNode } from "../templates/dynamic-content";
import type { Dynamic } from "../types";

const fmt = { time: () => "刚刚", num: (n: number) => String(n) };

const COVER = "https://i0.hdslb.com/bfs/archive/cover.jpg";
const PIC = "https://i0.hdslb.com/bfs/new_dyn/pic.jpg";

type ModuleDynamic = Dynamic["modules"]["module_dynamic"];
type Pic = NonNullable<NonNullable<NonNullable<ModuleDynamic["major"]>["opus"]>["pics"]>[number];

function author(name = "示例UP"): Dynamic["modules"]["module_author"] {
	return {
		avatar: {},
		face: "face.jpg",
		face_nft: false,
		following: false,
		jump_url: "",
		label: "",
		mid: 1,
		name,
		pub_action: "",
		pub_action_text: "",
		pub_location_text: "",
		pub_time: "刚刚",
		pub_ts: 0,
		type: "AUTHOR_TYPE_NORMAL",
		vip: { type: 0 },
	};
}

function dynamic(type: string, moduleDynamic: ModuleDynamic, over: Partial<Dynamic> = {}): Dynamic {
	return {
		basic: {},
		id_str: "1",
		type,
		visible: true,
		modules: {
			module_author: author(),
			module_dynamic: moduleDynamic,
			module_stat: { forward: { count: 1 }, comment: { count: 2 }, like: { count: 3 } },
		},
		...over,
	};
}

function richText(text: string) {
	return {
		text,
		rich_text_nodes: [{ type: "RICH_TEXT_NODE_TYPE_TEXT", orig_text: text, text }],
	};
}

function pics(n: number): Pic[] {
	return Array.from({ length: n }, () => ({
		width: 1000,
		height: 1000,
		url: PIC,
		size: 1,
		live_url: "",
	}));
}

/** 图文 / 纯文字 / 专栏共用的 opus 形态。 */
function opus(o: { summary?: string; title?: string; pics?: Pic[] }): ModuleDynamic {
	return {
		major: {
			type: "MAJOR_TYPE_OPUS",
			opus: {
				fold_action: [],
				jump_url: "",
				title: o.title,
				summary: o.summary === undefined ? undefined : richText(o.summary),
				pics: o.pics,
			},
		},
	};
}

function videoDynamic(): Dynamic {
	return dynamic("DYNAMIC_TYPE_AV", {
		desc: richText("投稿时配的一段话"),
		major: {
			type: "MAJOR_TYPE_ARCHIVE",
			archive: {
				badge: { text: "投稿视频" },
				cover: COVER,
				duration_text: "03:21",
				title: "视频标题在这里",
				desc: "视频简介",
				stat: { play: "1.2万", danmaku: "34" },
				bvid: "BV1xx411c7mD",
				jump_url: "",
			},
		},
	});
}

/** 把一份部件单独画出来(它自己就是根)。 */
async function htmlOf(vnode: VNode): Promise<string> {
	return renderToString(createSSRApp({ render: () => vnode }));
}

/** 一段 HTML 里出现过的全部挂点(`data-bn` 可以一次挂好几个,空格分开)。 */
function hooksIn(html: string): Set<string> {
	const hooks = new Set<string>();
	for (const m of html.matchAll(/data-bn="([^"]*)"/g)) {
		for (const hook of m[1].split(/\s+/)) hooks.add(hook);
	}
	return hooks;
}

/** 这份部件应当有 —— 顺手把类型收窄成 VNode。 */
function present(part: VNode | null | undefined, what: string): VNode {
	expect(part, `${what}应当有`).toBeTruthy();
	return part as VNode;
}

describe("buildDynamicNode —— 视频投稿", () => {
	it("text 是投稿时配的那段话,不带视频卡", async () => {
		const node = await buildDynamicNode(videoDynamic(), false, fmt);
		const html = await htmlOf(present(node.text, "text"));
		expect(html).toContain("投稿时配的一段话");
		// 富文本根上的 `body` 挂点跟着文字走。
		expect([...hooksIn(html)]).toEqual(["body"]);
		expect(html).not.toContain("视频标题在这里");
		expect(html).not.toContain(COVER);
	});

	it("media 是视频卡本身,三个挂点都在,不带正文", async () => {
		const node = await buildDynamicNode(videoDynamic(), false, fmt);
		const html = await htmlOf(present(node.media, "media"));
		expect(html).toMatch(/^<div data-bn="video"/);
		expect(html).toContain(COVER);
		expect(html).toContain("视频标题在这里");
		expect(hooksIn(html)).toEqual(new Set(["video", "videoCover", "videoTitle"]));
		expect(html).not.toContain("投稿时配的一段话");
	});
});

describe("buildDynamicNode —— 图文", () => {
	const draw = () => dynamic("DYNAMIC_TYPE_DRAW", opus({ summary: "图文的正文", pics: pics(3) }));

	it("text 是正文,不带图", async () => {
		const node = await buildDynamicNode(draw(), false, fmt);
		const html = await htmlOf(present(node.text, "text"));
		expect(html).toContain("图文的正文");
		expect([...hooksIn(html)]).toEqual(["body"]);
		expect(html).not.toContain(PIC);
	});

	it("media 是图廊本身 —— 不带 body 里跟在文字后面的那层间距,挂点都在", async () => {
		const node = await buildDynamicNode(draw(), false, fmt);
		const html = await htmlOf(present(node.media, "media"));
		// 根就是图廊:`mt-[8px]` 那层是「跟在文字后面」的间距,单独摆时归皮肤 CSS 管。
		expect(html).toMatch(/^<div data-bn="pics"/);
		expect(html).not.toContain("mt-[8px]");
		expect(html.match(/<img/g)).toHaveLength(3);
		expect(hooksIn(html)).toEqual(new Set(["pics", "pic"]));
		expect(html).not.toContain("图文的正文");
	});

	it("只有图没有字 → text 为空", async () => {
		const node = await buildDynamicNode(
			dynamic("DYNAMIC_TYPE_DRAW", opus({ pics: pics(1) })),
			false,
			fmt,
		);
		expect(node.text ?? null).toBeNull();
		expect(await htmlOf(present(node.media, "media"))).toMatch(/^<div data-bn="pics pic"/);
	});
});

describe("buildDynamicNode —— 纯文字", () => {
	it("text 是正文,media 为空", async () => {
		const node = await buildDynamicNode(
			dynamic("DYNAMIC_TYPE_WORD", { desc: richText("一条纯文字动态") }),
			false,
			fmt,
		);
		const html = await htmlOf(present(node.text, "text"));
		expect(html).toContain("一条纯文字动态");
		expect([...hooksIn(html)]).toEqual(["body"]);
		expect(node.media ?? null).toBeNull();
	});
});

describe("buildDynamicNode —— 专栏", () => {
	const article = () =>
		dynamic(
			"DYNAMIC_TYPE_ARTICLE",
			opus({ title: "专栏的标题", summary: "专栏的摘要", pics: pics(1) }),
		);

	it("text 是标题 + 摘要", async () => {
		const node = await buildDynamicNode(article(), false, fmt);
		const html = await htmlOf(present(node.text, "text"));
		expect(html).toContain("专栏的标题");
		expect(html).toContain("专栏的摘要");
		expect(html.indexOf("专栏的标题")).toBeLessThan(html.indexOf("专栏的摘要"));
		expect([...hooksIn(html)]).toEqual(["body"]);
		expect(html).not.toContain(PIC);
	});

	it("media 是头图那格图廊", async () => {
		const node = await buildDynamicNode(article(), false, fmt);
		const html = await htmlOf(present(node.media, "media"));
		// 单图时整个图廊就是那一格,两个挂点落在同一个元素上。
		expect(html).toMatch(/^<div data-bn="pics pic"/);
		expect(html).toContain(PIC);
		expect(html).not.toContain("专栏的");
	});
});

describe("buildDynamicNode —— 充电专属占位", () => {
	it("text 是那块占位,media 为空", async () => {
		// 未充电时接口把 module_dynamic 整体清空,不管外层 type 是什么都落到占位上。
		const node = await buildDynamicNode(
			dynamic("DYNAMIC_TYPE_AV", {}, { basic: { is_only_fans: true } }),
			false,
			fmt,
		);
		const html = await htmlOf(present(node.text, "text"));
		expect(html).toContain("充电专属内容");
		expect(html).toContain("为 示例UP 充电即可查看完整内容");
		expect(node.media ?? null).toBeNull();
	});
});

describe("buildDynamicNode —— 渲染不了的动态", () => {
	it.each([
		["DYNAMIC_TYPE_MUSIC", "示例UP发行了新歌，我暂时无法渲染，请自行查看"],
		["DYNAMIC_TYPE_UGC_SEASON", "示例UP更新了合集，我暂时无法渲染，请自行查看"],
		["DYNAMIC_TYPE_NONE", "示例UP发布了一条无效动态"],
		["DYNAMIC_TYPE_SOMETHING_NEW", "示例UP发布了一条我无法识别的动态，请自行查看"],
	])("%s → text 是那句提示,media 为空", async (type, notice) => {
		const node = await buildDynamicNode(
			dynamic(type, { desc: richText("不该出现的正文") }),
			false,
			fmt,
		);
		const html = await htmlOf(present(node.text, "text"));
		expect(html).toBe(`<p>${notice}</p>`);
		expect(node.media ?? null).toBeNull();
	});
});

describe("buildDynamicNode —— 转发", () => {
	const forward = (orig?: Dynamic) =>
		dynamic("DYNAMIC_TYPE_FORWARD", { desc: richText("转发时说的话") }, { orig });

	it("外层 text 只是转发语,media 为空;原动态的文字与图各在 forward 自己那两份里", async () => {
		const orig = dynamic("DYNAMIC_TYPE_DRAW", opus({ summary: "原动态的正文", pics: pics(2) }));
		const node = await buildDynamicNode(forward(orig), false, fmt);

		const text = await htmlOf(present(node.text, "外层 text"));
		expect(text).toContain("转发时说的话");
		expect(text).not.toContain("原动态的正文");
		expect(node.media ?? null).toBeNull();

		const inner = node.forward as DynamicNode;
		expect(inner).toBeDefined();
		const innerText = await htmlOf(present(inner.text, "原动态 text"));
		expect(innerText).toContain("原动态的正文");
		expect(innerText).not.toContain("转发时说的话");
		const innerMedia = await htmlOf(present(inner.media, "原动态 media"));
		expect(innerMedia).toMatch(/^<div data-bn="pics"/);
		expect(innerMedia.match(/<img/g)).toHaveLength(2);
	});

	it("原动态不可见 → 那句说明跟着转发语进 text(没有转发框可以装它)", async () => {
		const node = await buildDynamicNode(forward(), false, fmt);
		expect(node.forward).toBeUndefined();
		const text = await htmlOf(present(node.text, "text"));
		expect(text).toContain("转发时说的话");
		expect(text).toContain("示例UP转发了一条动态，但原动态已不可见");
		expect(text.indexOf("转发时说的话")).toBeLessThan(text.indexOf("原动态已不可见"));
		expect(node.media ?? null).toBeNull();
	});
});

describe("buildDynamicNode —— text 与 media 不共用 VNode 实例", () => {
	/**
	 * Vue 文档要求一棵组件树里的 vnode 各不相同 —— 客户端挂载时会往 vnode 上写 `el` /
	 * `component`,同一个实例出现在两处,后一处就把前一处的记录盖掉。出图走 SSR,实测共用
	 * 一个实例今天也画得出来(所以没有哪条测试会因为共用而红),但那是没承诺过的行为。
	 *
	 * 从前这里比的是 `body` 与拆出来的两半 —— `body` 已随 `content` 复合块退役(决策 8 的
	 * 2026-09-18 🔗),现在比的是剩下的两半彼此:皮肤把正文文字与视频卡摆进同一张卡是
	 * 常态(出厂默认皮肤就是这么摆的)。
	 *
	 * 唯一的例外是 `icons.tsx` 里那些**预求值的图标常量**:它们本来就是全模块共用的静态
	 * 节点(Vue 自己的编译器也这么提升静态节点),那是设计如此。
	 */
	it("两半各是各的实例(图标常量除外)", async () => {
		const shared = new Set<unknown>();
		for (const icon of Object.values(ICONS)) collectVNodes(icon, shared);

		const origDraw = dynamic("DYNAMIC_TYPE_DRAW", opus({ summary: "原动态", pics: pics(1) }));
		const cases: Dynamic[] = [
			videoDynamic(),
			dynamic("DYNAMIC_TYPE_DRAW", opus({ summary: "图文的正文", pics: pics(3) })),
			dynamic("DYNAMIC_TYPE_WORD", { desc: richText("纯文字") }),
			dynamic("DYNAMIC_TYPE_ARTICLE", opus({ title: "标题", summary: "摘要", pics: pics(1) })),
			dynamic("DYNAMIC_TYPE_AV", {}, { basic: { is_only_fans: true } }),
			dynamic("DYNAMIC_TYPE_MUSIC", {}),
			dynamic("DYNAMIC_TYPE_FORWARD", { desc: richText("转发语") }),
			dynamic("DYNAMIC_TYPE_FORWARD", { desc: richText("转发语") }, { orig: origDraw }),
		];
		for (const d of cases) {
			const outer = await buildDynamicNode(d, false, fmt);
			for (const node of outer.forward ? [outer, outer.forward] : [outer]) {
				const inText = collectVNodes(node.text, new Set());
				const inMedia = collectVNodes(node.media, new Set());
				expect(
					inText.size + inMedia.size,
					`${d.type} 的 text / media 应当画出点什么`,
				).toBeGreaterThan(0);
				const reused = [...inMedia].filter((v) => inText.has(v) && !shared.has(v));
				expect(reused, `${d.type} 的 text 与 media 共用了实例`).toEqual([]);
			}
		}
	});
});

/** 一棵 VNode 树里的全部节点(children 可以是嵌套数组、字符串、null)。 */
function collectVNodes(root: unknown, into: Set<unknown>): Set<unknown> {
	if (Array.isArray(root)) {
		for (const child of root) collectVNodes(child, into);
	} else if (isVNode(root)) {
		into.add(root);
		collectVNodes(root.children, into);
	}
	return into;
}
