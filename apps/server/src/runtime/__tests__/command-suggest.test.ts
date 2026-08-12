/**
 * 「你是不是想敲…」—— 未知指令的近似建议。
 *
 * 守的是**两头**:够近的要给出来(不然主人得自己去翻 help),够远的必须闭嘴
 * (乱指一条会让他照着敲第二次、第三次)。中间那条线由预算规则划,下面每条
 * 用例都在钉它的一侧。
 */

import { describe, expect, it } from "vite-plus/test";
import { suggestCommand } from "../command-suggest.js";

const TRIGGERS = ["help", "帮助", "?", "status", "状态", "mute", "静音", "report", "周报"];

describe("suggestCommand", () => {
	it("少打一个字母 → 指出最近的那条", () => {
		expect(suggestCommand("mut", TRIGGERS)).toBe("mute");
	});

	it("字母调序 —— 最常见的手滑,必须认出来", () => {
		// `hepl` 到 `help` 的编辑距离是 2(两次替换),预算按较长那侧算,够得着。
		expect(suggestCommand("hepl", TRIGGERS)).toBe("help");
	});

	it("中文错一个字 → 指出中文别名,不是英文主名", () => {
		// 建议是拿来照抄的:主人敲的是中文,回他一句英文主名等于让他重新学一遍。
		expect(suggestCommand("静因", TRIGGERS)).toBe("静音");
	});

	it("大小写不敏感 —— 手机输入法会自动首字母大写", () => {
		expect(suggestCommand("Mut", TRIGGERS)).toBe("mute");
	});

	it("差太远就闭嘴 —— 乱指一条比不指更糟", () => {
		expect(suggestCommand("weather", TRIGGERS)).toBeUndefined();
	});

	it("单字触发词不做模糊 —— 否则随便一个字母都会被指到「?」上", () => {
		expect(suggestCommand("a", TRIGGERS)).toBeUndefined();
	});

	it("空输入不给建议", () => {
		expect(suggestCommand("", TRIGGERS)).toBeUndefined();
	});

	it("没有候选时不给建议", () => {
		expect(suggestCommand("mut", [])).toBeUndefined();
	});

	it("多个候选取最近的那个", () => {
		// `状太` 离「状态」1 步,离「周报」2 步 —— 不能因为「周报」也在预算内就选它。
		expect(suggestCommand("状太", TRIGGERS)).toBe("状态");
	});

	it("并列时取注册在前的那个 —— 结果必须是确定的", () => {
		// 两条等距,输出不能随实现的遍历顺序漂移,否则同一次手滑两次跑出两个答案。
		expect(suggestCommand("xx", ["ax", "xb"])).toBe("ax");
	});
});
