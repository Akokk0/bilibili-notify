// @vitest-environment jsdom
/**
 * 从预览文档里数出「这一轮真画出来的块」(2026-09-18 主人反馈:各个场景画布都一样)。
 *
 * 画布画的是皮肤 JSON,而 JSON 只有一份 —— 切预览场景它一动不动。可真卡是分场景的:
 * `showIf` 判假、或者内置块这一场没数据,整块就不画(`render-skin.tsx` 的筛那一步)。
 * 编辑器得说出这件事,不然主人对着一堆块猜哪些这会儿有用。
 *
 * 块 id 本来就在真卡的 DOM 里(每个块 wrapper 带着 `bn-blk-<id>` 这个 class),所以数它就行。
 * 只认**外层网格的直接子**:转发框里那张内层卡跟着同一份皮肤走,外层没摆的块内层也可能画,
 * 但画布画的是外层那一层的布局。
 */

import { beforeEach, describe, expect, it } from "vite-plus/test";
import { drawnBlocks } from "../drawn-blocks";

function docWith(html: string): Document {
	document.body.innerHTML = html;
	return document;
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("drawnBlocks", () => {
	it("数出外层画了哪些块", () => {
		const doc = docWith(`
			<div class="glass">
				<div class="bn-blk-cover"></div>
				<div class="bn-blk-title"></div>
			</div>
		`);
		expect(drawnBlocks(doc)?.sort()).toEqual(["cover", "title"]);
	});

	it("转发框里的内层块不算 —— 画布画的是外层那一层", () => {
		const doc = docWith(`
			<div class="glass">
				<div class="bn-blk-forward">
					<div class="inner-grid">
						<div class="bn-blk-media"></div>
						<div class="bn-blk-text"></div>
					</div>
				</div>
			</div>
		`);
		expect(drawnBlocks(doc)).toEqual(["forward"]);
	});

	it("这一场没画的块就是不在里头 —— 画布据此把它淡掉", () => {
		const doc = docWith(`<div class="glass"><div class="bn-blk-text"></div></div>`);
		const drawn = drawnBlocks(doc);
		expect(drawn).toContain("text");
		expect(drawn).not.toContain("media");
	});

	it("读不到(文档里一个块都没有)→ null,画布一个都不淡", () => {
		expect(drawnBlocks(docWith(`<div class="glass"></div>`))).toBeNull();
	});

	it("id 里带 bn-blk- 的块也剥得对", () => {
		expect(
			drawnBlocks(docWith(`<div class="g"><div class="bn-blk-bn-blk-x"></div></div>`)),
		).toEqual(["bn-blk-x"]);
	});
});
