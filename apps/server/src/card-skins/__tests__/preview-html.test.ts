/**
 * 编辑器实时预览那条路(`renderSkinPreviewHtml`)。
 *
 * 这份**只钉接线**,不重复钉渲染器与示例数据 —— 那两头各有自己的测试,而它们各自全绿
 * 证明不了这条路把东西递过去了。皮肤这一摊已经栽过两次同族的:`cardSkin` 那个可选参数
 * 从头到尾没人传,两端单测全绿、类型也绿;示例数据从前另递的原始动态(`raw`)同理 —— 不传
 * 的话七种卡照样画得出来,只有皮肤作者写下 `{video.title}` 才发现那儿永远是空的。
 *
 * 契约的视频那一组如今跟着 `node.video` 走(ADR-0019 决策 68),`raw` 那一格已删。
 * 验红方式:让 `renderSkinPreviewHtml` 递给渲染器的 props 丢掉 `node.video`,这里当场红。
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

/** 转发框:`forward` 原子块自己的根,挂着根挂点 `bubble`。 */
const FORWARD_BUBBLE = 'data-bn="bubble"';

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

describe("实时预览 — 示例数据的视频真的递到了契约", () => {
	// ⚠️ 占位符前面那句前缀不是装饰:正文块**自己**也会把视频标题画出来,光断言
	// 「页面里有『示例视频』」的话,把契约那根线剪断照样绿。
	const PROBE = "<div>探针:{video.title}</div>";

	it("{video.title} 在预览里取得到 —— 视频没递进契约的话这儿永远是空的", async () => {
		// 视频那一场才有视频卡(默认那场是纯文字)。
		expect(await preview(skinWith(PROBE), "video")).toContain("探针:【示例视频】");
	});

	it("转发场面:内层那张卡取的是原动态的标题", async () => {
		const html = await preview(skinWith(PROBE), "forward");
		const at = html.indexOf(FORWARD_BUBBLE);
		expect(at, "这张卡上没有转发框").toBeGreaterThan(-1);
		const inset = html.slice(at);
		expect(inset).toContain("探针:【示例视频】");
	});
});

describe("实时预览 — 转发场面", () => {
	it("转发场面有转发框,纯文字场面没有", async () => {
		const [forward, text] = await Promise.all([
			preview(skinWith("<div>x</div>"), "forward"),
			preview(skinWith("<div>x</div>")),
		]);
		// 转发框是 `forward` 原子块自己的根,挂着根挂点 `bubble`。
		expect(forward).toContain(FORWARD_BUBBLE);
		expect(text).not.toContain(FORWARD_BUBBLE);
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
		expect(out.scene).toBe("text");
	});
});
