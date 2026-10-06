/**
 * 作品节点的两处结构性规矩(`nodeFromPost` 造出来的 node 与头像块)。
 *
 * 1. **头像只认 `Creator.avatar`(图库引用)**:拓展的头像存在图库里,引用经出卡器注入的解析口变成地址;B 站要到 3a
 *    才存头像,没有引用就不带头像地址,头像块整块收起(皮肤契约的 `creator.avatar` 是空串,字段表只增不删)。头像块自己
 *    吃的是 node 上的 `creatorAvatarUrl`:有地址就画、没地址整块收起。
 * 2. **`text` 与 `pics` 不共用 VNode 实例**:Vue 文档要求一棵组件树里的 vnode 各不相同,客户端挂载时会往 vnode
 *    上写 `el` / `component`,同一个实例出现在两处,后一处就把前一处的记录盖掉。皮肤把正文文字与图廊摆进同一张卡
 *    是常态(出厂默认皮肤就是这么摆的)。出图走 SSR,实测共用一个实例今天也画得出来(所以没有哪条出图测试会因
 *    为共用而红),但那是没承诺过的行为。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, isVNode, type VNode } from "vue";
import { POST_BLOCKS } from "../blocks/post";
import * as ICONS from "../icons";
import { buildGallery, type PostNode } from "../templates/post-content";
import { nodeFromPost } from "../templates/post-node";
import { DYNAMIC_SAMPLE_POSTS } from "./fixtures/post-fixtures";

const FMT = { time: () => "刚刚" };

const htmlOf = (vnode: VNode): Promise<string> =>
	renderToString(createSSRApp({ render: () => vnode }));

describe("头像 —— 只认 `Creator.avatar`(图库引用)", () => {
	const imageUrl = (ref: string) => `data:image/png;base64,${ref}`;

	/** 验红:让 `nodeFromPost` 不再读 `creator.avatar`,第一条红;读成地址直接塞进去,第二条红。 */
	it("外层、被转发的内层各有各的引用 —— 各解析各的", () => {
		const outer = nodeFromPost(
			{
				creator: { name: "外层", avatar: "outer.png" },
				publishedAt: "2023-11-14T22:13:20.000Z",
				text: "转发语",
				repost: {
					creator: { name: "内层", avatar: "inner.png" },
					publishedAt: "2023-11-14T22:13:20.000Z",
					text: "",
					locked: { title: "充电专属", hint: "h" },
				},
			},
			{ ...FMT, imageUrl },
		);
		expect(outer.creatorAvatarUrl).toBe("data:image/png;base64,outer.png");
		expect(outer.repost?.creatorAvatarUrl).toBe("data:image/png;base64,inner.png");
	});

	it("没有引用就没有头像地址:十份 B 站基准里没有一份画出头像(到 3a 才有)", () => {
		for (const post of Object.values(DYNAMIC_SAMPLE_POSTS)) {
			expect(nodeFromPost(post, { ...FMT, imageUrl }).creatorAvatarUrl).toBeUndefined();
		}
	});

	it("头像块:node 带了地址就画 <img>(拓展作品那条路)", async () => {
		const node: PostNode = {
			creatorAvatarUrl: "data:image/png;base64,FACE",
			creatorName: "某人",
			creatorIsPremium: false,
			time: "刚刚",
		};
		const vnode = POST_BLOCKS.avatar({ node, renderForward: () => [] });
		expect(vnode).not.toBeNull();
		const html = await htmlOf(vnode as VNode);
		expect(html).toContain('src="data:image/png;base64,FACE"');
		expect(html).toContain('alt="头像"');
		expect(html).toContain('data-bn="image"');
	});

	it("头像块:node 没有地址(或是空串)就整块收起,不画 src 为空的裂图", () => {
		const base = { creatorName: "某人", creatorIsPremium: false, time: "刚刚" };
		expect(POST_BLOCKS.avatar({ node: base, renderForward: () => [] })).toBeNull();
		expect(
			POST_BLOCKS.avatar({ node: { ...base, creatorAvatarUrl: "" }, renderForward: () => [] }),
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
			for (const node of outer.repost ? [outer, outer.repost] : [outer]) {
				const inText = collectVNodes(node.text, new Set());
				const inPics = collectVNodes(buildGallery(node.images ?? []), new Set());
				const reused = [...inPics].filter((v) => inText.has(v) && !shared.has(v));
				expect(reused, `${name} 的 text 与 pics 共用了实例`).toEqual([]);
			}
		}
	});
});
