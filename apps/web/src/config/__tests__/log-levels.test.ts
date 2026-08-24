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
import { LOG_LEVEL_TONE, LOG_LEVEL_TONE_CONSOLE, logLevelTint } from "../log-levels";

function rgb(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 相对亮度对比度。两张色表各自够不够看,只能这么量。 */
function contrast(a: string, b: string): number {
	const lum = (hex: string) => {
		const ch = rgb(hex).map((v) => {
			const c = v / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		}) as [number, number, number];
		return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
	};
	const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

const read = (rel: string) => readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("日志等级色表", () => {
	it("四档齐全,且 debug 走中性 —— 不占品牌色", () => {
		expect(Object.keys(LOG_LEVEL_TONE).sort()).toEqual(["debug", "error", "info", "warn"]);
		// 此前这条钉的是字面值 `#94a3b8`,而它想说的其实是「debug 得是中性灰蓝」——
		// 2026-08-24 整体加深时那个值就红了,红的是写法不是意图。改钉意图:
		// ① 不是品牌紫(`#a29bfe` 已被 PUSH_TONE.derived 与 --color-bn-purple 占着,
		//    给 debug 用会让最低优先级比 info 还扎眼);② 低饱和,也就是真的「灰」。
		expect(LOG_LEVEL_TONE.debug).not.toBe("#a29bfe");
		const [r, g, b] = rgb(LOG_LEVEL_TONE.debug);
		expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(60);
	});

	it("淡底从主色现调,不再各存一份 rgba 副本", () => {
		// 同上:钉的是「现调」这件事本身 —— 淡底必须由那一档的主色算出来,
		// 而不是另存一份写死的 rgba(那正是这张表当初要收掉的东西)。
		expect(logLevelTint("error")).toBe(
			`color-mix(in srgb, ${LOG_LEVEL_TONE.error} 10%, transparent)`,
		);
	});

	/**
	 * 两张表各管一头 —— **别把它们合回去**。
	 *
	 * 2026-08-24 加深是因为浅底上四档「分辨不出颜色来」(主人真机指出),原来那批
	 * 对白底只有 2.1~3.8:1。但同一批色在 `#0f1115` 的控制台上本来是 5~9:1,一深就
	 * 掉到 4 上下 —— 拿一头换另一头不算修好。所以浅底一张、控制台一张,这条测试
	 * 钉住两头各自够用。
	 */
	it("浅底那档在白底上够看,控制台那档在深底上够看", () => {
		for (const [k, v] of Object.entries(LOG_LEVEL_TONE)) {
			expect([k, contrast(v, "#ffffff") >= 4.5]).toEqual([k, true]);
		}
		for (const [k, v] of Object.entries(LOG_LEVEL_TONE_CONSOLE)) {
			expect([k, contrast(v, "#0f1115") >= 4.5]).toEqual([k, true]);
		}
	});

	it("两张表是同一批档位,不许一边多一档少一档", () => {
		expect(Object.keys(LOG_LEVEL_TONE_CONSOLE).sort()).toEqual(Object.keys(LOG_LEVEL_TONE).sort());
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
