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
					{
						id: "content",
						kind: "builtin",
						builtin: "content",
						grid: { row: 2, column: 1, span: 12 },
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
		const inset = html.slice(html.indexOf('data-bn="forward"'));
		expect(inset).toContain("探针:【示例视频】");
	});
});

describe("实时预览 — 转发场面", () => {
	it("转发场面有转发框,投稿场面没有", async () => {
		const [forward, av] = await Promise.all([
			preview(skinWith("<div>x</div>"), "forward"),
			preview(skinWith("<div>x</div>")),
		]);
		expect(forward).toContain('data-bn="forward"');
		expect(av).not.toContain('data-bn="forward"');
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
