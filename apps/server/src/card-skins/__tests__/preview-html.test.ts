/**
 * 编辑器实时预览那条路(`renderSkinPreviewHtml`)。
 *
 * 这份**只钉接线**,不重复钉渲染器与示例数据 —— 那两头各有自己的测试,而它们各自全绿
 * 证明不了这条路把东西递过去了。皮肤这一摊已经栽过两次同族的:`cardSkin` 那个可选参数
 * 从头到尾没人传,两端单测全绿、类型也绿;示例数据的 `raw` 同理 —— 不传的话七种卡照样
 * 画得出来,只有皮肤作者写下 `{video.title}` 才发现那儿永远是空的。
 *
 * 验红方式:把 `renderSkinPreviewHtml` 里递 `raw` 那一句删掉,这里当场红。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORWARD_INSET_CLASS } from "@bilibili-notify/image";
import { DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { renderSkinPreviewHtml } from "../preview-html.js";
import { CardSkinStore } from "../store.js";

let dir: string;
let store: CardSkinStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-card-preview-"));
	store = new CardSkinStore({ dir });
	await store.init();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** 一套动态卡皮肤:一个写着占位符的自定义块 + 正文块(转发框住在正文块里)。 */
function skinWith(html: string): unknown {
	return {
		...DEFAULT_CARD_SKIN,
		cards: {
			...DEFAULT_CARD_SKIN.cards,
			dynamic: {
				width: 600,
				blocks: [
					{ id: "probe", kind: "custom", html, grid: { row: 1, column: 1, span: 12 } },
					// 正文 / 视频标题 / 图廊 / 转发框 —— 从前都画在 `content` 复合块里,
					// 复合块退役后各是一块(ADR-0014 决策 8 的 2026-09-18 🔗)。
					{ id: "text", kind: "builtin", builtin: "text", grid: { row: 2, column: 1, span: 12 } },
					{
						id: "video-title",
						kind: "builtin",
						builtin: "videoTitle",
						grid: { row: 3, column: 1, span: 12 },
					},
					{
						id: "pics",
						kind: "builtin",
						builtin: "pics",
						grid: { row: 4, column: 1, span: 12 },
					},
					{
						id: "forward",
						kind: "builtin",
						builtin: "forward",
						grid: { row: 5, column: 1, span: 12 },
					},
				],
			},
		},
	};
}

async function preview(manifest: unknown, scene?: string): Promise<string> {
	const out = await renderSkinPreviewHtml({
		store,
		skinId: "default",
		kind: "dynamic",
		manifest,
		...(scene ? { scene } : {}),
	});
	if (!out.ok) throw new Error(`预览没画出来: ${out.errors.join(" / ")}`);
	return out.html;
}

describe("实时预览 — 示例数据的原始动态真的递到了渲染器", () => {
	// ⚠️ 占位符前面那句前缀不是装饰:正文块**自己**也会把视频标题画出来,光断言
	// 「页面里有『示例视频』」的话,把 raw 那根线剪断照样绿。
	const PROBE = "<div>探针:{video.title}</div>";

	it("{video.title} 在预览里取得到 —— 不递 raw 的话这儿永远是空的", async () => {
		expect(await preview(skinWith(PROBE))).toContain("探针:【示例视频】");
	});

	it("转发场面:内层那张卡取的是原动态的标题", async () => {
		const html = await preview(skinWith(PROBE), "forward");
		const at = html.indexOf(FORWARD_INSET_CLASS);
		expect(at, "这张卡上没有转发框").toBeGreaterThan(-1);
		const inset = html.slice(at);
		expect(inset).toContain("探针:【示例视频】");
	});
});

describe("实时预览 — 转发场面", () => {
	it("转发场面有转发框,投稿场面没有", async () => {
		const [forward, av] = await Promise.all([
			preview(skinWith("<div>x</div>"), "forward"),
			preview(skinWith("<div>x</div>")),
		]);
		// 转发框是 `forward` 原子块自己的根,挂点是 self,所以认它的 class 不认挂点。
		expect(forward).toContain(FORWARD_INSET_CLASS);
		expect(av).not.toContain(FORWARD_INSET_CLASS);
	});

	it("回报的 scene 是真正用上的那个 —— 名字不认识时回落到第一个", async () => {
		const out = await renderSkinPreviewHtml({
			store,
			skinId: "default",
			kind: "dynamic",
			manifest: skinWith("<div>x</div>"),
			scene: "这个场景不存在",
		});
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.scene).toBe("default");
	});
});

/**
 * **这一场是哪个形态**(ADR-0014 决策 10 的 2026-09-18 🔗)。
 *
 * 面板要靠它画「只改本场」那个开关、把拖出来的改动写进对的那份覆盖。**必须由这一端算**:
 * 面板照场景 id 自己猜的话,两处迟早对不上 —— 而且两张预览图本来就可能落在同一个形态上
 * (「全字段」与「视频投稿」都是视频)。
 */
describe("实时预览 — 回报这一场落在哪个形态", () => {
	async function variantOfScene(scene: string): Promise<string | null | undefined> {
		const out = await renderSkinPreviewHtml({
			store,
			skinId: "default",
			kind: "dynamic",
			manifest: DEFAULT_CARD_SKIN,
			scene,
		});
		if (!out.ok) throw new Error(out.errors.join(" / "));
		return out.variant;
	}

	it("动态卡四场各自落在哪一档", async () => {
		// 「全字段」与「视频投稿」都带视频卡 —— 同一个形态,这正是「按形态存、不按场景存」
		// 的理由:真机拿到一张卡分不出它是哪一「场」。
		expect(await variantOfScene("default")).toBe("video");
		expect(await variantOfScene("video")).toBe("video");
		expect(await variantOfScene("draw")).toBe("pics");
		expect(await variantOfScene("forward")).toBe("forward");
	});

	it("只有一种样子的卡种回 null(只有 base)", async () => {
		const out = await renderSkinPreviewHtml({
			store,
			skinId: "default",
			kind: "sc",
			manifest: DEFAULT_CARD_SKIN,
		});
		if (!out.ok) throw new Error(out.errors.join(" / "));
		expect(out.variant).toBeNull();
	});

	// 接线守卫:回报的那一档得和**真画出来**的那一档是同一个。各算各的话,面板会把改动
	// 写进一份根本没人用的覆盖里,而两边的门禁全绿。
	it("回报的那一档,就是装配时真用上的那一档", async () => {
		const marked = {
			...DEFAULT_CARD_SKIN,
			cards: {
				...DEFAULT_CARD_SKIN.cards,
				dynamic: {
					...DEFAULT_CARD_SKIN.cards.dynamic,
					// 三档各藏一个**四场都画得出来**的块(正文 / 话题在某些场面本来就没有,
					// 藏了也看不出差别)。真用上哪档,HTML 里就少哪一块。
					variants: {
						video: { blocks: { name: { hidden: true } } },
						pics: { blocks: { avatar: { hidden: true } } },
						forward: { blocks: { time: { hidden: true } } },
					},
				},
			},
		};
		const HIDDEN: Record<string, string> = { video: "name", pics: "avatar", forward: "time" };
		/**
		 * 这张卡上画了几个这个块 —— 转发卡内外两层各画一份,所以数个数而不是问有没有。
		 * 带上收尾那个引号只数 `class="…"`:光数 `bn-blk-text` 会把 CSS 里那条
		 * `.bn-blk-text{…}` 也数进来,块一收起规则也跟着没,一次掉两份。
		 */
		const count = (html: string, id: string): number => html.split(`bn-blk-${id}"`).length - 1;
		for (const scene of ["default", "video", "draw", "forward"]) {
			const args = { store, skinId: "default", kind: "dynamic" as const, scene };
			const plain = await renderSkinPreviewHtml({ ...args, manifest: DEFAULT_CARD_SKIN });
			const out = await renderSkinPreviewHtml({ ...args, manifest: marked });
			if (!plain.ok || !out.ok) throw new Error("预览没画出来");
			const gone = HIDDEN[out.variant ?? ""];
			expect(gone, `${scene} 没落在任何一档`).toBeDefined();
			// 转发那场:外层藏了时间,而框里那张是**视频**那一档,照画不误 —— 所以只能要求
			// 少一份,不能要求一份都不剩。
			expect(
				count(out.html, gone ?? ""),
				`${scene}:回报 ${out.variant},但 ${gone} 的份数没少`,
			).toBe(count(plain.html, gone ?? "") - 1);
		}
	});
});
