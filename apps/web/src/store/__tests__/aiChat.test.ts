// @vitest-environment jsdom
/**
 * 聊天界面的样式偏好 —— 主题色之外的两项:玻璃片透明度、完全透明。
 *
 * 这两项刻意跟推送卡片的 `cardStyle.glassOpacity` / `glassClear` 同名同义,
 * 主人在两处看到的是同一套说法。区别只在**存哪**:推送卡片那对是业务配置,
 * 落服务端;这一对是「这台设备上看着舒服」的偏好,跟主题色一样留在 localStorage。
 */

import { beforeEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_GLASS_OPACITY, normalizeGlassOpacity, useAiChatStore } from "../aiChat";

beforeEach(() => {
	localStorage.clear();
	useAiChatStore.setState({ glassOpacity: DEFAULT_GLASS_OPACITY, glassClear: false });
});

describe("玻璃片透明度", () => {
	it("默认值跟推送卡片的玻璃片基线是同一个数", () => {
		// 主人的原话:「默认和推送卡片的透明度保持一致」。推送卡片那边打开
		// glassOpacity 开关时给的就是 0.82。
		expect(DEFAULT_GLASS_OPACITY).toBe(0.82);
		expect(useAiChatStore.getState().glassOpacity).toBe(0.82);
	});

	it("调过的值写进 localStorage —— 刷新一次还得在", () => {
		useAiChatStore.getState().setGlassOpacity(0.4);
		expect(useAiChatStore.getState().glassOpacity).toBe(0.4);
		// key 硬写在这儿是有意的:它是**跨刷新的存储契约**,改掉就等于把主人
		// 之前调好的设置默默丢了。真要改,得先在这里改,顺带看见这句话。
		expect(localStorage.getItem("bn.aiChat.glassOpacity")).toBe("0.4");
	});

	it("越界的值被夹回 0..1,不靠调用方自觉", () => {
		// 滑块本身给不出越界值,但 localStorage 是**外部输入** —— 主人手改过、
		// 或者旧版本写过别的格式。夹一下,免得 alpha 算出个负数把面板画瞎。
		expect(normalizeGlassOpacity(1.7)).toBe(1);
		expect(normalizeGlassOpacity(-0.3)).toBe(0);
	});

	it("认不出来的值回落默认,而不是变成 NaN", () => {
		expect(normalizeGlassOpacity("蛤?")).toBe(DEFAULT_GLASS_OPACITY);
		expect(normalizeGlassOpacity(null)).toBe(DEFAULT_GLASS_OPACITY);
		expect(normalizeGlassOpacity(undefined)).toBe(DEFAULT_GLASS_OPACITY);
	});

	it("localStorage 里存的是字符串,读回来得是数", () => {
		expect(normalizeGlassOpacity("0.35")).toBe(0.35);
	});

	it("从没设过(localStorage 返回 null)也是默认值 —— 不是 0", () => {
		// 这条单独钉住,因为它是**第一次打开聊天**走的那条路。Number(null) 是 0,
		// 顺手写成那样的话,新主人第一眼看到的就是一片全透明的界面。
		expect(normalizeGlassOpacity(localStorage.getItem("从来没存过"))).toBe(DEFAULT_GLASS_OPACITY);
	});
});

describe("完全透明(去磨砂模糊)", () => {
	it("默认关着 —— 不开任何设置时界面该跟以前一模一样", () => {
		expect(useAiChatStore.getState().glassClear).toBe(false);
	});

	it("开了之后原来的透明度**留着**,关掉能回到那一档", () => {
		// 推送卡片那边开完全透明时把 glassOpacity 清成 undefined,因为那字段本来
		// 就有「未设」态。这里没有,清零的话主人关掉完全透明会掉进全透明,等于
		// 关了个寂寞 —— 留着值才关得回去。
		useAiChatStore.getState().setGlassOpacity(0.5);
		useAiChatStore.getState().setGlassClear(true);
		expect(useAiChatStore.getState().glassOpacity).toBe(0.5);
		useAiChatStore.getState().setGlassClear(false);
		expect(useAiChatStore.getState().glassClear).toBe(false);
		expect(useAiChatStore.getState().glassOpacity).toBe(0.5);
	});

	it("动一下透明度就自动关掉完全透明 —— 否则滑块拉了没反应", () => {
		// 完全透明优先级更高。开着它去拉滑块,画面纹丝不动,主人只会觉得滑块坏了。
		useAiChatStore.getState().setGlassClear(true);
		useAiChatStore.getState().setGlassOpacity(0.3);
		expect(useAiChatStore.getState().glassClear).toBe(false);
		expect(useAiChatStore.getState().glassOpacity).toBe(0.3);
	});

	it("开关也记在 localStorage", () => {
		useAiChatStore.getState().setGlassClear(true);
		expect(localStorage.getItem("bn.aiChat.glassClear")).toBe("1");
		useAiChatStore.getState().setGlassClear(false);
		expect(localStorage.getItem("bn.aiChat.glassClear")).toBe("0");
	});
});
