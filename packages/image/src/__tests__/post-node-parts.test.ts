/**
 * 作品节点的两处结构性规矩(`nodeFromPost` 造出来的 node 与头像块)。
 *
 * 1. **头像到 ㉑d / 3a 才有**:`Creator.avatar` 只收图库引用,出卡器目前不会按引用取图,所以 `Post` 这条路的
 *    node 不带头像地址,头像块整块收起(皮肤契约的 `up.face` 是空串,字段表只增不删)。拓展作品那条路
 *    (`apps/server/src/runtime/extension-post-work.ts`)自己造 node、带着头像地址,头像块照画。
 * 2. **`text` 与 `pics` 不共用 VNode 实例**:Vue 文档要求一棵组件树里的 vnode 各不相同,客户端挂载时会往 vnode
 *    上写 `el` / `component`,同一个实例出现在两处,后一处就把前一处的记录盖掉。皮肤把正文文字与图廊摆进同一张卡
 *    是常态(出厂默认皮肤就是这么摆的)。出图走 SSR,实测共用一个实例今天也画得出来(所以没有哪条出图测试会因
 *    为共用而红),但那是没承诺过的行为。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, isVNode, type VNode } from "vue";
import { DYNAMIC_BLOCKS } from "../blocks/dynamic";
import * as ICONS from "../icons";
import { buildGallery, type DynamicNode } from "../templates/dynamic-content";
import { nodeFromPost } from "../templates/post-node";
import { DYNAMIC_SAMPLE_POSTS } from "./fixtures/post-fixtures";

const FMT = { time: () => "刚刚" };

const htmlOf = (vnode: VNode): Promise<string> =>
	renderToString(createSSRApp({ render: () => vnode }));

describe("头像 —— `Post` 这条路不画,拓展作品那条路照画", () => {
	/** 验红:让 `nodeFromPost` 把 `creator.avatar` 当地址写进 `avatarUrl`,前两条红。 */
	it("`Post` 造出的 node 没有头像地址 —— 外层、被转发的内层、充电专属都是", () => {
		const outer = nodeFromPost(
			{
				creator: { name: "外层", avatar: "abc.png" },
				publishedAt: "2023-11-14T22:13:20.000Z",
				text: "转发语",
				repost: {
					creator: { name: "内层", avatar: "def.png" },
					publishedAt: "2023-11-14T22:13:20.000Z",
					text: "",
					locked: { title: "充电专属", hint: "h" },
				},
			},
			FMT,
		);
		expect(outer.avatarUrl).toBeUndefined();
		expect(outer.forward?.avatarUrl).toBeUndefined();
	});

	it("十份基准里没有一份画出头像", () => {
		for (const post of Object.values(DYNAMIC_SAMPLE_POSTS)) {
			expect(nodeFromPost(post, FMT).avatarUrl).toBeUndefined();
		}
	});

	it("头像块:node 带了地址就画 <img>(拓展作品那条路)", async () => {
		const node: DynamicNode = {
			avatarUrl: "data:image/png;base64,FACE",
			upName: "某人",
			upIsVip: false,
			pubTime: "刚刚",
		};
		const vnode = DYNAMIC_BLOCKS.avatar({ node, renderForward: () => [] });
		expect(vnode).not.toBeNull();
		const html = await htmlOf(vnode as VNode);
		expect(html).toContain('src="data:image/png;base64,FACE"');
		expect(html).toContain('alt="头像"');
		expect(html).toContain('data-bn="image"');
	});

	it("头像块:node 没有地址(或是空串)就整块收起,不画 src 为空的裂图", () => {
		const base = { upName: "某人", upIsVip: false, pubTime: "刚刚" };
		expect(DYNAMIC_BLOCKS.avatar({ node: base, renderForward: () => [] })).toBeNull();
		expect(
			DYNAMIC_BLOCKS.avatar({ node: { ...base, avatarUrl: "" }, renderForward: () => [] }),
		).toBeNull();
	});
});

describe("nodeFromPost —— text 与 pics 不共用 VNode 实例", () => {
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

	it("十份基准的每个 node(含转发的内层)里,两半各是各的实例(图标常量除外)", () => {
		// `icons.tsx` 里那些预求值的图标常量本来就是全模块共用的静态节点(Vue 自己的编译器也这么提升静态
		// 节点),那是设计如此。
		const shared = new Set<unknown>();
		for (const icon of Object.values(ICONS)) collectVNodes(icon, shared);

		for (const [name, post] of Object.entries(DYNAMIC_SAMPLE_POSTS)) {
			const outer = nodeFromPost(post, FMT);
			for (const node of outer.forward ? [outer, outer.forward] : [outer]) {
				const inText = collectVNodes(node.text, new Set());
				const inPics = collectVNodes(buildGallery(node.images ?? []), new Set());
				const reused = [...inPics].filter((v) => inText.has(v) && !shared.has(v));
				expect(reused, `${name} 的 text 与 pics 共用了实例`).toEqual([]);
			}
		}
	});
});
