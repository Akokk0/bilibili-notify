/**
 * **2026-09-18 补的那批原子块**(ADR-0014 决策 8 的 🔗):动态卡的话题 / 正文文字 / 视频卡或
 * 图廊 / 转发框 / 三个互动数,醒目留言卡的金额 / 时长胶囊 / 「SC to」那一行,上舰卡的用户名
 * 胶囊 / 主播胶囊。
 *
 * 这份钉的是「**单独摆进一套皮肤,画出来的就是那一件**」,以及没数据时整块收起。走的是真
 * 出图那条路(`renderCardWithSkin`)、喂的是编辑器预览的示例数据(`sampleCard`)—— 所以它
 * 同时是接线的守卫:块名在目录里、渲染器却没登记的话,皮肤路径会把整块当「没数据」悄悄收起,
 * 类型全绿,只有这里会红。
 *
 * 「与复合块里那一段逐字同形」不在这里钉,在 `__tests__/card-blocks.test.ts`;挂点对表在
 * `__tests__/card-hooks.test.ts`。
 */

import { type CardSkinKind, DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import { sampleCard } from "../../preview/sample-cards";
import { renderCardWithSkin } from "../render-skin";

/** 示例数据里那几句,在各自的卡上只出现在一处。 */
const AV_TEXT = "这是一段示例动态正文，用来看正文块的字号、行距与留白。";
const FORWARD_TEXT = "这是一段示例转发语，下面那张是被转发的原动态。";
const VIDEO_TITLE = "【示例视频】这是一条用来预览卡片的示例投稿标题";

/**
 * 一套只摆这几个内置块的皮肤,每块占一整行。画出来的整卡 HTML 解析成文档返回。
 */
async function renderWith(
	kind: CardSkinKind,
	builtins: string[],
	scene?: string,
): Promise<Document> {
	const sample = await sampleCard(kind, scene);
	const html = await renderCardWithSkin(
		kind,
		sample.props as never,
		{
			...DEFAULT_CARD_SKIN,
			cards: {
				...DEFAULT_CARD_SKIN.cards,
				[kind]: {
					width: 600,
					blocks: builtins.map((builtin, i) => ({
						id: `solo-${i}`,
						kind: "builtin",
						builtin,
						grid: { row: i + 1, column: 1, span: 12 },
					})),
				},
			},
		} as never,
		{ ...(sample.raw ? { raw: sample.raw } : {}) },
	);
	return new JSDOM(html).window.document;
}

/** 这个块画出来的全部 wrapper(内外两层合起来)。 */
function blocksOf(doc: Document, builtin: string): Element[] {
	return [...doc.querySelectorAll(`[data-block="${builtin}"]`)];
}

/** 这个块恰好画了一份,返回它**唯一的**那个元素孩子(= 原子块的根)。 */
function soleRoot(doc: Document, builtin: string): Element {
	const blocks = blocksOf(doc, builtin);
	expect(blocks, `${builtin} 应当恰好画一份`).toHaveLength(1);
	const children = [...blocks[0].children];
	expect(children, `${builtin} 的 wrapper 里应当只有一件`).toHaveLength(1);
	return children[0];
}

/** 一个元素上的挂点 token。 */
function hooksOn(el: Element): string[] {
	return (el.getAttribute("data-bn") ?? "").split(/\s+/).filter(Boolean);
}

/** 一个元素子树里出现过的挂点(含它自己)。 */
function hooksUnder(el: Element): Set<string> {
	const found = new Set(hooksOn(el));
	for (const d of el.querySelectorAll("[data-bn]")) for (const h of hooksOn(d)) found.add(h);
	return found;
}

describe("动态卡 — topic(话题)", () => {
	it("画的是话题那一行:图标 + 话题名,根挂着 text", async () => {
		const root = soleRoot(await renderWith("dynamic", ["topic"]), "topic");
		expect(root.textContent).toBe("示例话题");
		expect(root.querySelector("svg")?.getAttribute("aria-label")).toBe("话题");
		expect(hooksOn(root)).toEqual(["text"]);
	});

	it("没有话题的动态 → 整块收起", async () => {
		expect(blocksOf(await renderWith("dynamic", ["topic"], "video"), "topic")).toEqual([]);
	});
});

describe("动态卡 — text(正文文字)", () => {
	it("画的是正文富文本,带着 body 挂点,不带视频卡", async () => {
		const root = soleRoot(await renderWith("dynamic", ["text"]), "text");
		expect(root.textContent).toContain(AV_TEXT);
		expect(hooksOn(root)).toEqual(["body"]);
		expect(root.textContent).not.toContain(VIDEO_TITLE);
	});

	it("图文场面:正文在,九张图不在", async () => {
		const root = soleRoot(await renderWith("dynamic", ["text"], "pics"), "text");
		expect(root.textContent).toContain("这是一段示例图文正文");
		expect(root.querySelector("img")).toBeNull();
	});

	it("只有视频卡、没有正文的投稿 → 整块收起", async () => {
		expect(blocksOf(await renderWith("dynamic", ["text"], "video"), "text")).toEqual([]);
	});
});

describe("动态卡 — 投稿视频那张卡拆成的五块", () => {
	it("封面只是一张图,挂点在图上", async () => {
		const root = soleRoot(await renderWith("dynamic", ["videoCover"], "video"), "videoCover");
		expect(root.tagName).toBe("IMG");
		expect(hooksOn(root)).toEqual(["image"]);
		expect(root.textContent).toBe("");
	});

	it("标题 / 简介 / 播放弹幕各画各的一段,谁都不带正文", async () => {
		const html = await renderWith("dynamic", ["videoTitle", "videoDesc", "videoStats"], "video");
		expect(soleRoot(html, "videoTitle").textContent).toBe(VIDEO_TITLE);
		expect(soleRoot(html, "videoDesc").textContent).not.toContain(VIDEO_TITLE);
		// 播放 · 弹幕数那块是两个计数,不含标题也不含正文。
		expect(soleRoot(html, "videoStats").textContent).not.toContain(AV_TEXT);
	});

	it("时长角标不自带定位 —— 贴哪个角归皮肤说,根挂着 pill", async () => {
		const root = soleRoot(await renderWith("dynamic", ["videoDuration"], "video"), "videoDuration");
		expect(hooksOn(root)).toEqual(["pill"]);
		expect(root.getAttribute("class") ?? "").not.toMatch(/absolute|bottom-|right-/);
	});

	it("不是投稿视频 → 五块一起收起", async () => {
		const ids = ["videoCover", "videoDuration", "videoTitle", "videoDesc", "videoStats"];
		const html = await renderWith("dynamic", ids, "pics");
		for (const id of ids) expect(blocksOf(html, id), id).toEqual([]);
	});
});

describe("动态卡 — pics(图廊)", () => {
	it("图文:画的是图廊本身(九格),不带正文后面那层间距", async () => {
		const root = soleRoot(await renderWith("dynamic", ["pics"], "pics"), "pics");
		expect(hooksOn(root)).toEqual(["pics"]);
		expect(root.querySelectorAll('[data-bn="pic"]')).toHaveLength(9);
		expect(root.textContent).not.toContain("这是一段示例图文正文");
	});

	it("视频投稿没有图廊 → 整块收起", async () => {
		expect(blocksOf(await renderWith("dynamic", ["pics"], "video"), "pics")).toEqual([]);
	});

	it("转发那条自己没有图 → 整块收起(原动态的图归转发框里那张卡)", async () => {
		expect(blocksOf(await renderWith("dynamic", ["pics"], "forward"), "pics")).toEqual([]);
	});
});

describe("动态卡 — forward(转发框)", () => {
	it("画的是转发框本身,根挂着 bubble(不是复合块时代的 forward)", async () => {
		const root = soleRoot(await renderWith("dynamic", ["forward"], "forward"), "forward");
		expect(root.tagName).toBe("DIV");
		// 框的样子(灰底 / 圆角 / 左边那道蓝 / zoom)住在默认皮肤这个挂点的规则里,认框认它。
		expect(hooksOn(root)).toEqual(["bubble"]);
	});

	it("框里是原动态那张卡,跟着同一份皮肤摆:外层的正文是转发语,框里的是原动态正文", async () => {
		const doc = await renderWith("dynamic", ["forward", "text"], "forward");
		const inset = soleRoot(doc, "forward");
		const texts = blocksOf(doc, "text");
		expect(texts).toHaveLength(2);
		const [inner] = texts.filter((t) => inset.contains(t));
		const [outer] = texts.filter((t) => !inset.contains(t));
		expect(inner.textContent).toContain(AV_TEXT);
		expect(outer.textContent).toContain(FORWARD_TEXT);
		expect(inset.textContent).not.toContain(FORWARD_TEXT);
	});

	it("不是转发 → 整块收起", async () => {
		expect(blocksOf(await renderWith("dynamic", ["forward"]), "forward")).toEqual([]);
	});
});

describe("动态卡 — 三个互动数", () => {
	const CASES: Array<[builtin: string, label: string, count: string]> = [
		["forwardCount", "转发", "128"],
		["commentCount", "评论", "456"],
		["likeCount", "点赞", "7890"],
	];

	for (const [builtin, label, count] of CASES) {
		it(`${builtin}:画的是${label}那一项(图标 + 数),图标带 icon 挂点`, async () => {
			const root = soleRoot(await renderWith("dynamic", [builtin]), builtin);
			expect(root.textContent).toBe(count);
			const icons = root.querySelectorAll('[data-bn="icon"]');
			expect(icons).toHaveLength(1);
			expect(icons[0].getAttribute("aria-label")).toBe(label);
			expect(hooksOn(root)).toEqual(["text"]);
		});

		it(`${builtin}:转发框里的原动态没有互动数 → 框里那份收起,外层照画`, async () => {
			const doc = await renderWith("dynamic", ["forward", builtin], "forward");
			const inset = soleRoot(doc, "forward");
			const all = blocksOf(doc, builtin);
			expect(all).toHaveLength(1);
			expect(inset.contains(all[0])).toBe(false);
		});
	}
});

describe("醒目留言卡 — price / duration / to", () => {
	it("price:画的是金额数字,档位色的两个变量跟着它自己走", async () => {
		const root = soleRoot(await renderWith("sc", ["price"]), "price");
		expect(root.textContent).toBe("¥100");
		const style = root.getAttribute("style") ?? "";
		// 金额是渐变裁字:两个变量缺一个,字就是透明的 —— 复合块里它们挂在根上,单独摆没有那个根。
		expect(style).toContain("--bn-card-tier-color:");
		expect(style).toContain("--bn-card-tier-color-end:");
		expect(hooksOn(root)).toEqual(["text"]);
	});

	it("duration:画的是时长胶囊(图标 + 时长),档位色变量跟着它自己走", async () => {
		const root = soleRoot(await renderWith("sc", ["duration"]), "duration");
		expect(root.querySelector("svg")).not.toBeNull();
		expect(root.textContent?.trim()).not.toBe("");
		expect(root.textContent).not.toContain("¥");
		expect(root.getAttribute("style") ?? "").toContain("--bn-card-tier-color:");
		expect(hooksOn(root)).toEqual(["pill"]);
	});

	it("to:画的是「SC to」那一行,主播小头像与主播名的挂点都在", async () => {
		const root = soleRoot(await renderWith("sc", ["to"]), "to");
		expect(root.textContent).toContain("SC to");
		expect(root.textContent).toContain("示例 UP 主");
		expect(root.textContent).not.toContain("示例粉丝");
		expect(hooksOn(root)).toEqual(["text"]);
		expect(hooksUnder(root)).toEqual(
			new Set(["text", "label", "master", "masterAvatar", "masterName"]),
		);
	});
});

describe("上舰卡 — user / master", () => {
	it("user:画的是用户名胶囊,档位色变量跟着它自己走", async () => {
		const root = soleRoot(await renderWith("guard", ["user"]), "user");
		expect(root.textContent).toBe("示例粉丝");
		expect(root.getAttribute("style") ?? "").toContain("--bn-card-tier-color:");
		expect(hooksUnder(root)).toEqual(new Set(["pill", "text"]));
	});

	it("master:画的是主播胶囊,主播小头像与主播名的挂点都在", async () => {
		const root = soleRoot(await renderWith("guard", ["master"]), "master");
		expect(root.textContent).toBe("示例 UP 主");
		expect(root.getAttribute("style") ?? "").toContain("--bn-card-tier-color:");
		expect(hooksOn(root)).toEqual(["pill"]);
		expect(hooksUnder(root)).toEqual(new Set(["pill", "masterAvatar", "masterName"]));
	});
});
