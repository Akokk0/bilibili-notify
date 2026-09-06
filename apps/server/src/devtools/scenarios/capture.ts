import type { CaptureGate } from "../capture.js";
import type { DevScenarioDef } from "../registry.js";

/**
 * D1:推送截流。跑一下 = 开闸,收摊 = 关闸;拦下的都在面板「截流」组那张列表里。
 */
export function pushCaptureScenario(gate: CaptureGate): DevScenarioDef {
	return {
		id: "push.capture",
		group: "capture",
		title: "推送截流",
		desc: "开着时所有推送出口都不真发(开播 / 动态 / 链接回卡 / 指令回复全在内),拦下的列在这一组;历史照记 delivered 不打标,清历史行按截流的时间段删。收摊即恢复真发。",
		quick: true,
		icon: "filter",
		params: [],
		run() {
			gate.enable();
			return { summary: "截流已开:从现在起推送只进列表,不出网。" };
		},
		active() {
			return gate.enabled()
				? { scenarioId: "push.capture", label: `推送截流中 · 拦下 ${gate.count()} 条` }
				: null;
		},
		reset() {
			gate.disable();
		},
	};
}
