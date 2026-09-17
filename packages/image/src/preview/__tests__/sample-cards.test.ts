/**
 * 出厂示例卡片数据(`preview/sample-cards.ts`)—— 编辑器实时预览喂给渲染器的那一套 props。
 *
 * 这份数据**唯一真正的判据是「真渲染得出来」**:props 的形状对不对,类型门只管得到一半
 * (`data` 是 any、`node` 是画好的结构树、档位色是元组…),少一个字段、字段名手抄错一个字母,
 * 编译照过、预览现场才空一块。所以这里不比字符串,直接过一遍 `renderCardWithSkin`。
 *
 * 场景表本身(七种卡齐全 / id 不重复)钉在 `packages/internal` 那头 —— 表住在 internal,
 * 因为面板也要读它。
 */

import { readFileSync } from "node:fs";
import { CARD_PREVIEW_SCENES, CARD_SKIN_KINDS, DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { renderCardWithSkin } from "../../skin/render-skin";
import { sampleCard } from "../sample-cards";

/** 卡外框的挂点(`data-bn="frame"`)—— 画出来的东西至少得有个外框。 */
const FRAME_HOOK = /data-bn="(?:[^"]*\s)?frame(?:\s[^"]*)?"/;

async function render(kind: (typeof CARD_SKIN_KINDS)[number], scene?: string): Promise<string> {
	// `as never`:出口刻意回 unknown(示例数据不是对外契约,别让调用方照它写类型),
	// 这里替调用方把 props 递进去。
	const sample = await sampleCard(kind, scene);
	return renderCardWithSkin(kind, sample.props as never, DEFAULT_CARD_SKIN, {
		...(sample.raw ? { raw: sample.raw } : {}),
	});
}

describe("出厂示例数据 — 七种卡都画得出来", () => {
	for (const kind of CARD_SKIN_KINDS) {
		it(`${kind}:默认场景渲染出带外框的 HTML`, async () => {
			const html = await render(kind);
			expect(html).toMatch(FRAME_HOOK);
			// 空壳也带外框,所以再要一句:玻璃层里至少落了一个块。
			expect(html).toContain("data-block=");
		});
	}
});

describe("出厂示例数据 — 直播卡三个场景", () => {
	it("三个场景都渲染得通,且两两不同", async () => {
		const ids = CARD_PREVIEW_SCENES.live.map((s) => s.id);
		const htmls = await Promise.all(ids.map((id) => render("live", id)));
		for (const html of htmls) expect(html).toMatch(FRAME_HOOK);
		// 两两不同:三个场景要是喂出同一份 props,场景等于没做 —— 而面板上三个按钮照样点得动。
		expect(new Set(htmls).size).toBe(ids.length);
	});
});

describe("出厂示例数据 — 场景回落", () => {
	for (const kind of CARD_SKIN_KINDS) {
		it(`${kind}:不认识的场景名回落到第一个场景,与不传 scene 逐字节相同`, async () => {
			const [fallback, bare, first] = await Promise.all([
				render(kind, "这个场景不存在"),
				render(kind),
				render(kind, CARD_PREVIEW_SCENES[kind][0].id),
			]);
			expect(fallback).toBe(bare);
			expect(fallback).toBe(first);
		});
	}
});

describe("出厂示例数据 — 确定性", () => {
	/**
	 * 防回归:示例数据一旦碰时钟或随机数,预览就会自己飘 —— 用户改一行 CSS 再画一次,
	 * 出来的差异里混着数据的抖动,而这种抖动在单次渲染里看不出来。所以直接读自己的源码钉住。
	 */
	it("模块里没有时钟 / 随机数的调用", () => {
		const src = readFileSync(new URL("../sample-cards.ts", import.meta.url), "utf8");
		for (const banned of ["Date.now", "new Date", "Math.random"]) {
			expect(src).not.toContain(banned);
		}
	});

	it("同样入参连画两次,产出逐字节相同", async () => {
		const [a, b] = await Promise.all([render("live", "ended"), render("live", "ended")]);
		expect(a).toBe(b);
	});
});

/**
 * **转发场面**(2026-09-15 加)。内层动态卡这一整层 —— 转发框、框里那张跟着皮肤走的卡 ——
 * 在编辑器里原本一眼都看不到:动态卡只有一个场面,示例数据里没有转发。皮肤作者改不着自己
 * 看不见的东西。
 */
describe("出厂示例数据 — 动态卡的转发场面", () => {
	it("转发场面画得出转发框,全字段场面没有", async () => {
		const [forward, av] = await Promise.all([render("dynamic", "forward"), render("dynamic")]);
		expect(forward).toContain('data-bn="forward"');
		expect(av).not.toContain('data-bn="forward"');
	});

	it("框里是另一整张卡 —— 块跟着同一份皮肤摆,不是写死的旧版式", async () => {
		const html = await render("dynamic", "forward");
		const inset = html.slice(html.indexOf('data-bn="forward"'));
		// 内层的块与外层挂同一批 class(皮肤的块 id),所以一条 CSS 管两层。
		expect(inset).toContain("bn-blk-");
	});
});

/**
 * 一套只有「条件块」的探针皮肤:每个字段一个块,块里是 `有:<字段>`,`showIf` 就是那个字段。
 * 画出来之后看哪几句在,就知道这个场面下哪几个真值为真 —— 走的是渲染器真实的取值那条路。
 */
async function truthy(scene: string, fields: readonly string[]): Promise<Record<string, boolean>> {
	const sample = await sampleCard("dynamic", scene);
	const html = await renderCardWithSkin(
		"dynamic",
		sample.props as never,
		{
			...DEFAULT_CARD_SKIN,
			cards: {
				...DEFAULT_CARD_SKIN.cards,
				dynamic: {
					width: 600,
					blocks: fields.map((field, i) => ({
						id: `probe-${i}`,
						kind: "custom",
						html: `<div>有:${field}</div>`,
						showIf: field,
						grid: { row: i + 1, column: 1, span: 12 },
					})),
				},
			},
		} as never,
		{ ...(sample.raw ? { raw: sample.raw } : {}) },
	);
	return Object.fromEntries(fields.map((f) => [f, html.includes(`有:${f}`)]));
}

/**
 * **视频投稿场面**(2026-09-17 主人要的)。默认场面为了让写皮肤的人一次看全,正文、话题、
 * 预约全堆上了;真机上 UP 发视频推过来的那张没有这些 —— 只有头部、视频卡和互动数,群里贴
 * 视频链接出的卡也是这个形状。只看默认场面的话,皮肤作者不知道「没有正文」时卡长什么样。
 */
describe("出厂示例数据 — 动态卡的视频投稿场面", () => {
	it("有视频卡、头部带「投稿了视频」;没有正文、话题、预约", async () => {
		const html = await render("dynamic", "video");
		expect(html).toContain("【示例视频】");
		expect(html).toContain("投稿了视频");
		// 这三样默认场面里都有 —— 回落到默认场面的话这里红。
		expect(html).not.toContain("示例动态正文");
		expect(html).not.toContain("示例话题");
		expect(html).not.toContain("示例预约");
	});

	it("真值:带视频卡,没有话题、没有附加内容", async () => {
		expect(
			await truthy("video", ["dynamic.hasVideo", "dynamic.hasTopic", "dynamic.hasAdditional"]),
		).toEqual({
			"dynamic.hasVideo": true,
			"dynamic.hasTopic": false,
			"dynamic.hasAdditional": false,
		});
	});

	it("动态卡的场面两两不同", async () => {
		const ids = CARD_PREVIEW_SCENES.dynamic.map((s) => s.id);
		const htmls = await Promise.all(ids.map((id) => render("dynamic", id)));
		expect(new Set(htmls).size).toBe(ids.length);
	});
});

/**
 * **图文场面**(2026-09-17 加)。契约里的 `pics.*` 与 `dynamic.hasPics` 从前没有一个场面带图,
 * 皮肤作者写了也看不到;图廊的样式(九宫格、长图角标)同样无处可看。给的是图廊最满的情况。
 */
describe("出厂示例数据 — 动态卡的图文场面", () => {
	it("图廊铺满九格,没有视频卡", async () => {
		const html = await render("dynamic", "draw");
		expect(html.match(/data-bn="pic"/g)?.length).toBe(9);
		expect(html).not.toContain("【示例视频】");
	});

	it("{pics.count} 是 9,{pics.first} 取得到第一张图", async () => {
		const sample = await sampleCard("dynamic", "draw");
		const html = await renderCardWithSkin(
			"dynamic",
			sample.props as never,
			{
				...DEFAULT_CARD_SKIN,
				cards: {
					...DEFAULT_CARD_SKIN.cards,
					dynamic: {
						width: 600,
						blocks: [
							{
								id: "probe",
								kind: "custom",
								html: "<div>探针:{pics.count}|探针图:{pics.first}</div>",
								grid: { row: 1, column: 1, span: 12 },
							},
						],
					},
				},
			} as never,
			{ ...(sample.raw ? { raw: sample.raw } : {}) },
		);
		expect(html).toContain("探针:9|");
		expect(html).toContain("探针图:data:image/svg+xml");
	});

	it("真值:带图,没有视频卡", async () => {
		expect(await truthy("draw", ["dynamic.hasPics", "dynamic.hasVideo"])).toEqual({
			"dynamic.hasPics": true,
			"dynamic.hasVideo": false,
		});
	});
});

/**
 * **契约里那两组「要原始动态才取得到」的字段**(视频卡 / 图廊)。
 *
 * 它们在 `node` 里已经被画进正文的 VNode、拆不回来,只能从原始动态取 —— 所以渲染器收一个
 * 可选的 `raw`。预览这条路**从来没传过它**:类型全绿、七种卡照样画得出来,只有皮肤作者写下
 * `{video.title}` 才发现那儿永远是空的。这份钉的就是那根线。
 */
describe("出厂示例数据 — 视频 / 图廊那组字段在预览里取得到", () => {
	/**
	 * 一套两个块的皮肤:一个自定义块(里头就一个占位符)+ 正文块。
	 * 正文块不能省 —— 转发框住在它里头,没有它就没有内层那张卡。
	 */
	const probeSkin = (html: string) =>
		({
			...DEFAULT_CARD_SKIN,
			cards: {
				...DEFAULT_CARD_SKIN.cards,
				dynamic: {
					width: 600,
					blocks: [
						{ id: "probe", kind: "custom", html, grid: { row: 1, column: 1, span: 12 } },
						{
							id: "content",
							kind: "builtin",
							builtin: "content",
							grid: { row: 2, column: 1, span: 12 },
						},
					],
				},
			},
		}) as never;

	async function probe(scene: string | undefined, placeholder: string): Promise<string> {
		const sample = await sampleCard("dynamic", scene);
		return await renderCardWithSkin(
			"dynamic",
			sample.props as never,
			probeSkin(`<div>${placeholder}</div>`),
			{ ...(sample.raw ? { raw: sample.raw } : {}) },
		);
	}

	// ⚠️ 前缀不是装饰:正文块自己也画视频标题,光找「示例视频」的话剪断 raw 照样绿。
	it("{video.title} 在全字段场面取得到", async () => {
		expect(await probe(undefined, "探针:{video.title}")).toContain("探针:【示例视频】");
	});

	it("showIf 的 dynamic.hasVideo 也随之为真", async () => {
		const sample = await sampleCard("dynamic");
		const html = await renderCardWithSkin(
			"dynamic",
			sample.props as never,
			{
				...DEFAULT_CARD_SKIN,
				cards: {
					...DEFAULT_CARD_SKIN.cards,
					dynamic: {
						width: 600,
						blocks: [
							{
								id: "probe",
								kind: "custom",
								html: "<div>有视频</div>",
								showIf: "dynamic.hasVideo",
								grid: { row: 1, column: 1, span: 12 },
							},
						],
					},
				},
			} as never,
			{ ...(sample.raw ? { raw: sample.raw } : {}) },
		);
		expect(html).toContain("有视频");
	});

	it("转发场面里,内层那张卡取的是**原动态**的视频标题", async () => {
		const html = await probe("forward", "探针:{video.title}");
		const inset = html.slice(html.indexOf('data-bn="forward"'));
		expect(inset).toContain("探针:【示例视频】");
	});
});
