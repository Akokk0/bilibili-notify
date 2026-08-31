/**
 * SELECTED_LANGUAGE —— 「这一项当前被选中 / 激活」的全站统一语汇。
 *
 * 统一前五处各配各的:描边透明度 100 / 60 / 40 三档、粉纱 6 / 8 / 10 / 12% 四档。
 * 定案配方来自 Subs 分组胶囊(2026-08-30 主人真机三轮拍板):全浓粉描边 + 粉字 +
 * **不透明**粉调底。说这句话的:Subs 分组胶囊、FontPicker 候选行、备份 ChoiceCard、
 * scope-tabs「添加 UP」展开态。只要那块不透明粉底的(Subs 批量状态条、About 徽章、
 * chrome-autodetect 粉药丸)单独吃 SELECTED_TINT_BG。
 */

import { describe, expect, it } from "vite-plus/test";
import { SELECTED_LANGUAGE, SELECTED_TINT_BG } from "../atoms";

describe("SELECTED_LANGUAGE", () => {
	it("底是 color-mix 落在 surface 上的不透明出法 —— 不是靠白页垫底的纱", () => {
		// 混 surface 不混 transparent:bg-bn-pink/10 那类纱在壁纸皮肤把页面换掉后
		// 当场隐形(Subs 分组胶囊踩过的雷)。默认装上两种写法等值。
		expect(SELECTED_TINT_BG).toBe(
			"bg-[color-mix(in_srgb,var(--color-bn-pink)_10%,var(--color-bn-surface))]",
		);
	});

	it("整句 = 全浓粉描边 + 不透明粉底 + 粉字,一个不多一个不少", () => {
		// toEqual 钉死类集合:谁往句子里塞新词、谁把描边退回 /60 之类的淡档,这里红。
		expect(SELECTED_LANGUAGE.split(/\s+/)).toEqual([
			"border",
			"border-bn-pink",
			SELECTED_TINT_BG,
			"text-bn-pink",
		]);
	});
});
