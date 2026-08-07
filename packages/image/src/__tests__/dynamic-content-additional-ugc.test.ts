/**
 * 附加内容 —— 关联视频卡(ADDITIONAL_TYPE_UGC)。
 *
 * 图文动态正文里带一条「关联视频」时,B 站放在 module_dynamic.additional.ugc,
 * 官方页面渲染成封面 + 时长 + 标题 + 播放/弹幕的小卡。此前 buildAdditionalContent
 * 只认 RESERVE / GOODS / COMMON,UGC 落进 default 返回 null,整块视频卡就没了。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, h } from "vue";
import { renderCard } from "../render";
import { DynamicCard } from "../templates/dynamic-card";
import { buildDynamicNode } from "../templates/dynamic-content";
import type { Dynamic } from "../types";

const fmt = { time: () => "刚刚", num: (n: number) => String(n) };

function makeAuthor() {
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
	} as Dynamic["modules"]["module_author"];
}

function makeStat() {
	return { forward: { count: 0 }, comment: { count: 0 }, like: { count: 0 } };
}

/** 真实抓包字段(取自 .interface/dynamic_video.json 的 DYNAMIC_TYPE_DRAW 条目)。 */
function ugcPayload(over: Record<string, unknown> = {}) {
	return {
		id_str: "117000193967716",
		head_text: "",
		title: "中国人能飞~✈️✈️✈️",
		desc_second: "2654观看 102弹幕",
		jump_url: "//www.bilibili.com/video/BV1Zn366gEJe",
		cover: "http://i1.hdslb.com/bfs/archive/d75b1c59.jpg",
		duration: "00:29",
		multi_line: true,
		...over,
	};
}

// biome-ignore lint/suspicious/noExplicitAny: 构造测试用的 additional,类型同源码一样不固定
function makeDynamic(additional: any): Dynamic {
	return {
		basic: {},
		id_str: "1233319070468669440",
		type: "DYNAMIC_TYPE_DRAW",
		visible: true,
		modules: {
			module_author: makeAuthor(),
			module_dynamic: {
				desc: {
					text: "中国人能飞",
					rich_text_nodes: [
						{ type: "RICH_TEXT_NODE_TYPE_TEXT", orig_text: "中国人能飞", text: "中国人能飞" },
					],
				} as Dynamic["modules"]["module_dynamic"]["desc"],
				additional,
			},
			module_stat: makeStat(),
		},
	};
}

async function additionalHtml(dynamic: Dynamic): Promise<string> {
	const node = await buildDynamicNode(dynamic, false, fmt);
	expect(node.additional).not.toBeNull();
	const app = createSSRApp({ render: () => h("div", [node.additional]) });
	return renderToString(app);
}

describe("buildAdditionalContent — 关联视频(ADDITIONAL_TYPE_UGC)", () => {
	it("渲染出封面、时长、标题与播放/弹幕文本", async () => {
		const html = await additionalHtml(
			makeDynamic({ type: "ADDITIONAL_TYPE_UGC", ugc: ugcPayload() }),
		);
		expect(html).toContain("中国人能飞~✈️✈️✈️");
		expect(html).toContain("00:29");
		expect(html).toContain("2654观看 102弹幕");
		expect(html).toContain("http://i1.hdslb.com/bfs/archive/d75b1c59.jpg");
	});

	it("head_text 非空时渲染出来,为空时不留空行", async () => {
		const withHead = await additionalHtml(
			makeDynamic({ type: "ADDITIONAL_TYPE_UGC", ugc: ugcPayload({ head_text: "up主的视频" }) }),
		);
		expect(withHead).toContain("up主的视频");

		// 抓包里 head_text 常为空串,不能因此渲染出一条空的灰字行。
		const noHead = await additionalHtml(
			makeDynamic({ type: "ADDITIONAL_TYPE_UGC", ugc: ugcPayload() }),
		);
		expect(noHead).not.toContain('class="flex items-center gap-1 text-[12px] text-[#999]');
	});

	it("缺 duration / desc_second 时照样出卡,不渲染 undefined", async () => {
		const html = await additionalHtml(
			makeDynamic({
				type: "ADDITIONAL_TYPE_UGC",
				ugc: ugcPayload({ duration: undefined, desc_second: undefined }),
			}),
		);
		expect(html).toContain("中国人能飞~✈️✈️✈️");
		expect(html).not.toContain("undefined");
	});

	it("type 是 UGC 但 ugc 字段缺席 → 收起附加块,不抛错", async () => {
		const node = await buildDynamicNode(
			makeDynamic({ type: "ADDITIONAL_TYPE_UGC", ugc: null }),
			false,
			fmt,
		);
		expect(node.additional).toBeNull();
	});

	it("仍不认的 additional 类型 → 保持收起", async () => {
		const node = await buildDynamicNode(
			makeDynamic({ type: "ADDITIONAL_TYPE_UPOWER_LOTTERY", upower_lottery: {} }),
			false,
			fmt,
		);
		expect(node.additional).toBeNull();
	});

	// 见 render-uno-scan.test.ts:UnoCSS 扫的是渲染后的整份 HTML,Fragment 锚点
	// `<!--[-->` 里那个落单的 `[` 会一路吃到后面第一个 `]`,把中途的类名并成无效
	// token。被吞的类名只要别处复用过就看不出问题,而视频卡的封面尺寸是全卡唯一
	// 的 —— 一旦被吞,封面就没了尺寸约束,而构建 / 类型 / lint 全绿。
	it("封面尺寸类名真的生成了 CSS 规则,没被 Fragment 锚点吞掉", async () => {
		const node = await buildDynamicNode(
			makeDynamic({ type: "ADDITIONAL_TYPE_UGC", ugc: ugcPayload() }),
			false,
			fmt,
		);
		const html = await renderCard(
			DynamicCard,
			{ cardColorStart: "#000000", cardColorEnd: "#ffffff", node },
			{ htmlWidth: 600 },
		);
		const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
		for (const cls of ["w-[140px]", "h-[80px]"]) {
			// UnoCSS 输出里类名的方括号是反斜杠转义的:`w-[140px]` → `.w-\[140px\]{…}`。
			const selector = `.${cls.replace(/[[\]]/g, (c) => `\\${c}`)}`;
			expect(
				css.includes(`${selector}{`) || css.includes(`${selector},`),
				`${cls} 的规则没生成`,
			).toBe(true);
		}
	});
});
