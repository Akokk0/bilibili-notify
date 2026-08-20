/**
 * 日志等级色表的唯一性守卫 —— 与 `push-kinds` 同一个理由,见该文件头注。
 *
 * 这份表此前抄在三处并且**已经飘了**:`debug` 在 Logs 是灰蓝 `#94a3b8`、在
 * LogLevelPicker 与 Dashboard 是品牌紫 `#a29bfe`;`warn` 是 `#f2a053` vs `#f59e0b`。
 * 同一条日志在三个界面上三种颜色,没有任何东西拦下一次再飘。
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { LOG_LEVEL_TONE, logLevelTint } from "../log-levels";

const read = (rel: string) => readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("日志等级色表", () => {
	it("四档齐全,且严重度越高越扎眼(debug 走中性,不占品牌色)", () => {
		expect(Object.keys(LOG_LEVEL_TONE).sort()).toEqual(["debug", "error", "info", "warn"]);
		// debug 是最低优先级,必须是中性灰蓝 —— 给它品牌紫会让它比 info 还显眼,
		// 而且 `#a29bfe` 已经被 PUSH_TONE.derived 与 --color-bn-purple 占着了。
		expect(LOG_LEVEL_TONE.debug).toBe("#94a3b8");
	});

	it("淡底从主色现调,不再各存一份 rgba 副本", () => {
		expect(logLevelTint("error")).toBe("color-mix(in srgb, #ef4444 10%, transparent)");
	});

	/**
	 * 判据是「引用统一表 + 本地表定义清零」,**不是**扫 hex 字面量 ——
	 * 那样会把不相干的同色用法一并拦下(实测误报三处:Logs 刻意保留的
	 * `PAUSED_TONE`、Dashboard 净增为 0 时的中性灰、统计卡的品牌紫)。
	 */
	it("三处消费方都从这里取色,不再各存一份本地表", async () => {
		for (const rel of [
			"../../pages/Logs.tsx",
			"../../components/forms.tsx",
			"../../pages/Dashboard.tsx",
		]) {
			const src = await read(rel);
			expect(`${rel} 引用统一表 ${src.includes("config/log-levels")}`).toBe(
				`${rel} 引用统一表 true`,
			);
		}
		// 三份旧的本地表,一个都不许复活。
		expect((await read("../../pages/Logs.tsx")).includes("const LEVEL_TONE")).toBe(false);
		expect((await read("../../pages/Dashboard.tsx")).includes("const LOG_LEVEL_TONE")).toBe(false);
		expect((await read("../../components/forms.tsx")).includes('label: "调试", color: "#')).toBe(
			false,
		);
	});
});
