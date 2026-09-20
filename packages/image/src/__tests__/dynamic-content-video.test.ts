/**
 * DYNAMIC_TYPE_AV 的主视频卡 —— 封面是主体。
 *
 * 与直播卡对齐:直播卡把封面整块铺在最上面、文字压在下面,视频卡此前却是「左边一条
 * 固定宽的缩略图 + 右边一列字」的横条 —— 同一次推送里两张卡长得像两个产品。
 *
 * 这里钉的是**版面骨架**(封面占满整宽、时长角标自带深色底、封面不再整张压暗),
 * 字号与间距属观感,留手动验证。
 */

import { describe, expect, it } from "vite-plus/test";
import { buildDynamicNode } from "../templates/dynamic-content";
import type { Dynamic } from "../types";
import { renderViaDefaultSkin } from "./fixtures/skin-render";

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

/**
 * 整张动态卡(出厂默认皮肤)。视频卡从前是一整块画好的 VNode,现在是五个原子块 + 皮肤用
 * 网格与 CSS 拼出来的容器(决策 8 的 2026-09-18 🔗)—— 「排成什么样」只有走皮肤才看得见。
 */
async function videoCardHtml(dynamic: Dynamic = makeVideoDynamic()): Promise<string> {
	const node = await buildDynamicNode(dynamic, false, fmt);
	return await renderViaDefaultSkin("dynamic", { node }, { htmlWidth: 600 });
}

/** 封面 img 自己的 class —— 封面是主体还是缩略图,全写在这一串里。 */
function coverImgClass(html: string): string {
	const m = html.match(new RegExp(`<img[^>]*class="([^"]*)"[^>]*src="${COVER}"`));
	if (!m) throw new Error(`没找到封面图:\n${html}`);
	return m[1];
}

/** 那一块的**格子层**的 style(网格坐标写在这儿,ADR-0018)。 */
function blockStyle(html: string, id: string): string {
	const m = html.match(new RegExp(`data-cell="${id}" style="([^"]*)"`));
	if (!m) throw new Error(`这张卡上没有「${id}」这一块`);
	return m[1];
}

describe("主视频卡 —— 封面作为主体", () => {
	it("封面占满整块宽度,不再挤在左边那条固定宽的缩略图列里", async () => {
		const html = await videoCardHtml();
		const cls = coverImgClass(html);
		expect(cls).toContain("w-full");
		// 老版式是 `relative w-40 shrink-0`:一旦有人把缩略图列改回来,这里就红。
		expect(cls, "封面不该再有宽度上限或收缩约束").not.toMatch(/\bw-\d|\bw-\[|shrink-0/);
		// 而且它在网格里是通栏的,不是挤在某几列里。
		expect(blockStyle(html, "video-cover")).toContain("grid-column:1 / span 12");
	});

	it("时长角标自己衬一层深色底,封面不再整张压暗", async () => {
		const html = await videoCardHtml();
		// 角标只画自己(渲染器一个 class 都不带),深色底与白字住在出厂默认皮肤这一块的
		// `pill` 规则里(决策 7 的 2026-09-19 🔗)。封面右下角是什么颜色由 UP 决定,亮底上
		// 纯白字加阴影会糊没 —— 与关联视频小卡同款处理。
		expect(html).toContain('<span data-bn="pill">16:07</span>');
		const pill = /\.bn-blk-video-duration \[data-bn~="pill"\]\{([^}]*)\}/.exec(html)?.[1] ?? "";
		expect(pill, "默认皮肤没给时长角标写底色").toContain("background:rgba(0,0,0,.6)");
		expect(pill).toContain("color:#fff");
		// 主体封面整张压暗会让卡片发灰:角标既然自带底,这层遮罩就没有存在理由了。
		expect(html).not.toContain("inset-0 bg-black/20");
	});

	it("角标落在封面占的那几行**之内**、层次更高 —— 叠在封面右下角,不是排在它下面", async () => {
		const html = await videoCardHtml();
		const cover = blockStyle(html, "video-cover");
		const badge = blockStyle(html, "video-duration");
		const span = (style: string) => {
			const m = /grid-row:(\d+) \/ span (\d+)/.exec(style);
			if (!m) throw new Error(`没有 grid-row:${style}`);
			return { from: Number(m[1]), to: Number(m[1]) + Number(m[2]) - 1 };
		};
		const c = span(cover);
		const b = span(badge);
		// 角标只占一行(它就一颗小标签),而且是封面那几行里的**最后一行** —— 那一行的
		// 下沿就是封面的下沿,`align-self:end` 贴上去正好在封面底部。
		expect(b).toEqual({ from: c.to, to: c.to });
		expect(badge).toContain("z-index:");
		expect(cover).not.toContain("z-index:");
	});

	it("标题 / 简介 / 播放弹幕都排在封面下方", async () => {
		// 只看 `<style>` 之后那截:整张卡的 CSS 里到处是数字,「129」在里头一搜一个准。
		const html = (await videoCardHtml()).split("</style>")[1] ?? "";
		const cover = html.indexOf(COVER);
		expect(cover).toBeGreaterThanOrEqual(0);
		for (const text of ["MC恐怖地图 毒药", "剪辑：@雲開七幺七", "1.8万", "129"]) {
			expect(html.indexOf(text), `${text} 应在封面之后`).toBeGreaterThan(cover);
		}
	});

	it("缺简介 / 缺时长时对应的块整个不出现,不留空块", async () => {
		// 抓包里 desc 常是空串;首映等形态没有 duration_text。空着照画的话,标题与播放数
		// 之间会多出一条空白行,封面上还会多出一块空的深色角标 —— 而且那块还带着灰底。
		const html = await videoCardHtml(makeVideoDynamic({ desc: "", duration_text: "" }));
		expect(html).not.toContain("undefined");
		expect(html, "简介那一块不该出现").not.toContain("bn-blk-video-desc");
		expect(html, "时长角标那一块不该出现").not.toContain("bn-blk-video-duration");
		// 其余三块照旧。
		for (const id of ["video-cover", "video-title", "video-stats"]) {
			expect(html, `${id} 该照画`).toContain(`bn-blk-${id}`);
		}
	});

	// 见 render-uno-scan.test.ts:Fragment 锚点 `<!--[-->` 里那个落单的 `[` 会一路吃到
	// 后面第一个 `]`,把中途的类名并成无效 token。被吞的类名只要别处复用过就看不出问题,
	// 下面这几个是这张卡独有的。
	it("这张卡独有的类名真的生成了 CSS 规则,没被 Fragment 锚点吞掉", async () => {
		const html = await videoCardHtml();
		const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
		// 外观类整批搬进皮肤之后(决策 7 的 2026-09-19 🔗),这张卡自己剩下的只有结构类;
		// `line-clamp-2` 是其中唯一只长在这张卡上的一个(标题与简介各一处)。
		for (const cls of ["line-clamp-2"]) {
			const selector = `.${cls.replace(/[[\]]/g, (c) => `\\${c}`)}`;
			expect(
				css.includes(`${selector}{`) || css.includes(`${selector},`),
				`${cls} 的规则没生成`,
			).toBe(true);
		}
	});
});
