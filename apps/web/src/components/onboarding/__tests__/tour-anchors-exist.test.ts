/**
 * 引导声明的每个挂点,页面上都得**真有一个**。
 *
 * 🔴 这条缝跨两端而且此前**一道门禁都没有**:词表(`TOUR_ANCHORS`)住引导这边,挂点
 * (`data-tour="…"`)长在各自的控件上。改一个控件的挂点名、或者把那个控件整个删掉,
 * 引导这侧的类型照旧过、测试照旧绿 —— 而聚光灯照到的是空气。症状是「导览走到这一步
 * 高亮没了」,只有真机上眼睛看得出来(ADR-0012 决策 23 里那条飘掉的 `adapter-add` 就是
 * 这么来的:重命名那一轮控件改了名,引导没跟着)。
 *
 * 判据刻意宽松到「这个词以字符串字面值出现在某个页面 / 组件文件里」—— 因为有几处挂点是
 * **条件挂的**(`data-tour={失败时 ? "target-config" : undefined}`),按属性写死去匹配的话
 * 这条守卫会把正确的写法判红。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { TOUR_ANCHORS } from "../tour-script";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** 引导自己那几个文件不算数 —— 词表与用词表的代码都在里头,自我印证。 */
const ONBOARDING_DIR = join(SRC_DIR, "components", "onboarding");

function listTsx(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "__tests__") continue;
			out.push(...listTsx(full));
		} else if (entry.endsWith(".tsx")) out.push(full);
	}
	return out;
}

describe("导览挂点", () => {
	it("每个声明过的挂点,页面上都真有一处", () => {
		const files = [
			...listTsx(join(SRC_DIR, "pages")),
			...listTsx(join(SRC_DIR, "components")),
		].filter((file) => !file.startsWith(ONBOARDING_DIR));
		const text = files.map((file) => readFileSync(file, "utf8")).join("\n");

		const missing = TOUR_ANCHORS.filter((anchor) => !text.includes(`"${anchor}"`));

		expect(missing).toEqual([]);
	});
});
