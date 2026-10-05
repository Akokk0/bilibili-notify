/**
 * B 站作品卡上的数字:**先成数字、再由 internal 统一排版**(㉑c 第 3 步,ADR-0021 决策 24)。
 *
 * 接口给的播放 / 弹幕数是数字或「1.8万」这种成品字,时长是「16:07」这种成品字。`buildDynamicNode` 先把它们
 * 解析成数字(`bili-display-values.ts`),再交给 `formatCount` / `formatClock` 排一次版。解析不出来的那一格
 * 不画,不画 NaN,也不把认不得的字原样画上去。
 *
 * 会变字节的只有两类,都是排版逼的:时长的前导零消失(「00:29」→「0:29」),接口给整数「万」时补上
 * 一位小数(「1万」→「1.0万」)。数字原样回得去的(「16:07」「1.8万」「129」)字节不变,由
 * `card-baseline.test.ts` 的快照钉着。
 *
 * 互动数(转发 / 评论 / 点赞)本来就是数字,经注入的 `fmt.num`;出卡器注入的就是 `formatCount`,
 * 在 `neutral-dynamic-card.test.ts` 里钉着。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, type VNode } from "vue";
import { buildDynamicNode } from "../templates/dynamic-content";
import type { Dynamic } from "../types";

const fmt = { time: () => "刚刚", num: (n: number) => String(n) };

const htmlOf = (vnode: VNode): Promise<string> =>
	renderToString(createSSRApp({ render: () => vnode }));

function dynamicWith(type: string, moduleDynamic: Record<string, unknown>): Dynamic {
	return {
		basic: {},
		id_str: "1",
		type,
		visible: true,
		modules: {
			module_author: {
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
			},
			module_dynamic: moduleDynamic,
			module_stat: { forward: { count: 1 }, comment: { count: 2 }, like: { count: 3 } },
		},
	} as unknown as Dynamic;
}

/** 一条投稿视频动态;`archive` 里的数字相关字段由用例给。 */
function videoDynamic(archive: Record<string, unknown>): Dynamic {
	return dynamicWith("DYNAMIC_TYPE_AV", {
		major: {
			type: "MAJOR_TYPE_ARCHIVE",
			archive: {
				badge: { text: "投稿视频" },
				cover: "https://i0.hdslb.com/bfs/archive/cover.jpg",
				title: "标题",
				desc: "",
				bvid: "BV1xx411c7mD",
				jump_url: "",
				duration_text: "16:07",
				stat: { play: "1.8万", danmaku: "129" },
				...archive,
			},
		},
	});
}

async function videoOf(archive: Record<string, unknown>) {
	const node = await buildDynamicNode(videoDynamic(archive), false, fmt);
	if (!node.video) throw new Error("这条动态没有视频");
	return node.video;
}

describe("主视频的播放数与弹幕数 —— 解析成数字再 formatCount", () => {
	it.each([
		// [接口给的, 排出来的]
		["1.8万", "1.8万"],
		["12.3万", "12.3万"],
		["129", "129"],
		["0", "0"],
		[129, "129"],
		[12_345, "1.2万"],
		// 排版逼的:整数「万」补一位小数
		["1万", "1.0万"],
		["100万", "100.0万"],
		["1.2亿", "1.2亿"],
	])("接口给 %j → 卡上 %s", async (given, shown) => {
		const video = await videoOf({ stat: { play: given, danmaku: given } });
		expect(video.views).toBe(shown);
		expect(video.danmaku).toBe(shown);
	});

	/** 验红:让 `videoOf` 回到 `String(archive.stat.play)`,这条红。 */
	it.each(["", "--", "10万+", "1,234", "abc", null, undefined])(
		"认不得的 %j → 那一格不画(没有 views / danmaku),不是 NaN 也不是原样的字",
		async (given) => {
			const video = await videoOf({ stat: { play: given, danmaku: given } });
			expect(video.views).toBeUndefined();
			expect(video.danmaku).toBeUndefined();
		},
	);

	it("播放数认得、弹幕数认不得:只画播放数那一格", async () => {
		const video = await videoOf({ stat: { play: "1.8万", danmaku: "--" } });
		expect(video.views).toBe("1.8万");
		expect(video.danmaku).toBeUndefined();
	});
});

describe("主视频的时长 —— 解析成秒再 formatClock", () => {
	it.each([
		["16:07", "16:07"],
		["1:02:03", "1:02:03"],
		["01:02:03", "1:02:03"],
		// 排版逼的:前导零消失
		["03:21", "3:21"],
		["00:29", "0:29"],
		["00:00", "0:00"],
	])("接口给 %j → 卡上 %s", async (given, shown) => {
		expect((await videoOf({ duration_text: given })).duration).toBe(shown);
	});

	it.each(["", "abc", "16", "16:60", undefined])(
		"没有或认不得的 %j → 时长是空串(角标那一块收起)",
		async (given) => {
			expect((await videoOf({ duration_text: given })).duration).toBe("");
		},
	);
});

describe("引用视频(UGC 附加卡)的时长 —— 同样解析成秒再 formatClock;desc_second 原样", () => {
	const ugc = (over: Record<string, unknown> = {}) => ({
		type: "ADDITIONAL_TYPE_UGC",
		ugc: {
			id_str: "1",
			head_text: "",
			title: "关联视频",
			desc_second: "2654观看 102弹幕",
			jump_url: "",
			cover: "http://i1.hdslb.com/bfs/archive/c.jpg",
			duration: "00:29",
			multi_line: true,
			...over,
		},
	});

	async function ugcHtml(over: Record<string, unknown> = {}): Promise<string> {
		const node = await buildDynamicNode(
			dynamicWith("DYNAMIC_TYPE_DRAW", { additional: ugc(over) }),
			false,
			fmt,
		);
		if (!node.additional) throw new Error("没有附加块");
		return htmlOf(node.additional);
	}

	it("「00:29」→「0:29」,「1:02:03」不变,「01:02:03」→「1:02:03」", async () => {
		expect(await ugcHtml({ duration: "00:29" })).toMatch(/>0:29<\/span>/);
		expect(await ugcHtml({ duration: "1:02:03" })).toMatch(/>1:02:03<\/span>/);
		expect(await ugcHtml({ duration: "01:02:03" })).toMatch(/>1:02:03<\/span>/);
	});

	it("没有或认不得的时长 → 角标不画", async () => {
		for (const duration of ["", "abc", "16:60", undefined]) {
			expect(await ugcHtml({ duration })).not.toContain("rounded-[3px]");
		}
	});

	it("desc_second 是接口拼好的整句,原样画,不拆不重排", async () => {
		expect(await ugcHtml({ desc_second: "2654观看 102弹幕" })).toContain("2654观看 102弹幕");
		expect(await ugcHtml({ desc_second: "1.2万观看 1万弹幕" })).toContain("1.2万观看 1万弹幕");
	});
});

describe("互动数 —— 本来就是数字,经注入的 fmt.num,原样交过去", () => {
	it("转发 / 评论 / 点赞的数字不经任何字符串中转地交给 fmt.num", async () => {
		const seen: unknown[] = [];
		const node = await buildDynamicNode(dynamicWith("DYNAMIC_TYPE_WORD", {}), false, {
			time: () => "刚刚",
			num: (n) => {
				seen.push(n);
				return `<${n}>`;
			},
		});
		expect(seen).toEqual([1, 2, 3]);
		expect(node.stats).toEqual({ forward: "<1>", comment: "<2>", like: "<3>" });
	});
});
