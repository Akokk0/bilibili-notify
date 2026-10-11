import { describe, expect, it } from "vite-plus/test";
import { resolveDynamicColorOptions } from "../card-style";

/**
 * 动态卡 colorOptions 的解析规则从 DynamicEngine 里提出来了 —— 独立端的链接卡也要
 * 按同一条规则出图。这里只钉纯函数;引擎那侧的行为仍由 dynamic-engine.test 钉着。
 *
 * 从前这份还钉着「背景图每次推送轮换」的三条。整条 `cardStyle.backgroundImages` 链
 * 2026-09-20 删掉(背景图归皮肤的 `image` 旋钮),剩下的就是一道 enable 闸。
 */
describe("resolveDynamicColorOptions", () => {
	it("enable 的原样给出去", () => {
		const style = { enable: true, font: "Comic Sans MS" };
		expect(resolveDynamicColorOptions(style)).toBe(style);
	});

	it("enable=false / 缺省 → undefined(调用点据此回退渲染器全局配置)", () => {
		expect(resolveDynamicColorOptions({ enable: false, font: "X" })).toBeUndefined();
		expect(resolveDynamicColorOptions(undefined)).toBeUndefined();
	});
});
