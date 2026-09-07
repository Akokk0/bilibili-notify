/**
 * DYNAMIC_TYPE_AV 的主视频卡 —— 封面是主体。
 *
 * 与直播卡对齐:直播卡把封面整块铺在最上面、文字压在下面,视频卡此前却是「左边一条
 * 固定宽的缩略图 + 右边一列字」的横条 —— 同一次推送里两张卡长得像两个产品。
 *
 * 这里钉的是**版面骨架**(封面占满整宽、时长角标自带深色底、封面不再整张压暗),
 * 字号与间距属观感,留手动验证。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, h } from "vue";
import { renderCard } from "../render";
import { DynamicCard } from "../templates/dynamic-card";
import { buildDynamicNode } from "../templates/dynamic-content";
import type { Dynamic } from "../types";

const fmt = { time: () => "刚刚", num: (n: number) => String(n) };

const COVER = "http://i1.hdslb.com/bfs/archive/15644012e6961428b08a947ec83365747c741d41.jpg";

/** 真实抓包字段(取自 .interface/dynamic_video.json 的 DYNAMIC_TYPE_AV 条目)。 */
function makeVideoDynamic(over: Record<string, unknown> = {}): Dynamic {
	return {
		basic: {},
		id_str: "1233319070468669440",
		type: "DYNAMIC_TYPE_AV",
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
			} as Dynamic["modules"]["module_author"],
			module_dynamic: {
				major: {
					type: "MAJOR_TYPE_ARCHIVE",
					archive: {
						badge: { text: "投稿视频" },
						cover: COVER,
						duration_text: "16:07",
						title: "因为揭穿了他们的秘密！我们遭到了陷害！MC恐怖地图 毒药",
						desc: "剪辑：@雲開七幺七",
						stat: { play: "1.8万", danmaku: "129" },
						bvid: "BV1FTGM69EFQ",
						jump_url: "//www.bilibili.com/video/BV1FTGM69EFQ",
						...over,
					},
				},
			},
			module_stat: { forward: { count: 0 }, comment: { count: 0 }, like: { count: 0 } },
		},
	};
}

/** 只渲染正文(= 这条动态自己的字 + 主视频卡),不带卡框与头像行。 */
async function videoBodyHtml(dynamic: Dynamic = makeVideoDynamic()): Promise<string> {
	const node = await buildDynamicNode(dynamic, false, fmt);
	const app = createSSRApp({ render: () => h("div", [node.body]) });
	return renderToString(app);
}

/** 包着封面图的那个元素的 class —— 封面是主体还是缩略图,全写在这一串里。 */
function coverWrapperClass(html: string): string {
	const m = html.match(new RegExp(`<div class="([^"]*)"[^>]*>\\s*<img[^>]*src="${COVER}"`));
	if (!m) throw new Error(`没找到封面图的外层元素:\n${html}`);
	return m[1];
}

describe("主视频卡 —— 封面作为主体", () => {
	it("封面占满整块宽度,不再挤在左边那条固定宽的缩略图列里", async () => {
		const cls = coverWrapperClass(await videoBodyHtml());
		expect(cls).toContain("w-full");
		// 老版式是 `relative w-40 shrink-0`:一旦有人把缩略图列改回来,这里就红。
		expect(cls, "封面容器不该再有宽度上限或收缩约束").not.toMatch(/\bw-\d|\bw-\[|shrink-0/);
	});

	it("时长角标自己衬一层深色底,封面不再整张压暗", async () => {
		const html = await videoBodyHtml();
		expect(html).toContain("16:07");
		// 封面右下角是什么颜色由 UP 决定,亮底上纯白字加阴影会糊没 —— 与关联视频小卡同款处理。
		expect(html).toMatch(/<span class="[^"]*bg-black\/[^"]*"[^>]*>16:07<\/span>/);
		// 主体封面整张压暗会让卡片发灰:角标既然自带底,这层遮罩就没有存在理由了。
		expect(html).not.toContain("inset-0 bg-black/20");
	});

	it("标题 / 简介 / 播放弹幕都排在封面下方", async () => {
		const html = await videoBodyHtml();
		const cover = html.indexOf(COVER);
		expect(cover).toBeGreaterThanOrEqual(0);
		for (const text of ["MC恐怖地图 毒药", "剪辑：@雲開七幺七", "1.8万", "129"]) {
			expect(html.indexOf(text), `${text} 应在封面之后`).toBeGreaterThan(cover);
		}
	});

	it("缺简介 / 缺时长时对应的元素整个收起,不留空块", async () => {
		// 抓包里 desc 常是空串;首映等形态没有 duration_text。空着照画的话,标题与播放数
		// 之间会多出一条空白行,封面上还会多出一块空的深色角标。
		const html = await videoBodyHtml(makeVideoDynamic({ desc: "", duration_text: "" }));
		expect(html).not.toContain("undefined");
		expect(html, "有带 class 的空元素说明某一行空着也照画了").not.toMatch(
			/<(div|span) class="[^"]*"><\/\1>/,
		);
	});

	// 见 render-uno-scan.test.ts:Fragment 锚点 `<!--[-->` 里那个落单的 `[` 会一路吃到
	// 后面第一个 `]`,把中途的类名并成无效 token,而主视频卡正好挂在一个 Fragment 里。
	// 被吞的类名只要别处复用过就看不出问题,下面这几个是这张卡独有的。
	it("这张卡独有的类名真的生成了 CSS 规则,没被 Fragment 锚点吞掉", async () => {
		const node = await buildDynamicNode(makeVideoDynamic(), false, fmt);
		const html = await renderCard(
			DynamicCard,
			{ cardColorStart: "#000000", cardColorEnd: "#ffffff", node },
			{ htmlWidth: 600 },
		);
		const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
		for (const cls of ["p-[12px]", "bottom-[8px]", "right-[8px]"]) {
			const selector = `.${cls.replace(/[[\]]/g, (c) => `\\${c}`)}`;
			expect(
				css.includes(`${selector}{`) || css.includes(`${selector},`),
				`${cls} 的规则没生成`,
			).toBe(true);
		}
	});
});
