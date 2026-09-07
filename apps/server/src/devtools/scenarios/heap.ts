import type { HeapInjectorHandle } from "../heap-injection.js";
import type { DevScenarioDef } from "../registry.js";

/**
 * 堆压力 —— 概览页资源卡那个环在 85% 转橙、95% 转红,服务端同时出一条 warn。
 *
 * 造的是**读数**:占比、warn 判定、sparkline 全照真的跑一遍(见 `heap-injection.ts`)。
 * 默认 92% 是橙那一档 —— 想看的就是它;要看红的改成 96。
 */

/** 默认 92%:橙那一档正中间,离 85 与 95 都够远,不会因为四舍五入看走眼。 */
const DEFAULT_RATIO = 92;

export interface HeapScenarioDeps {
	heap: HeapInjectorHandle;
}

export function heapPressureScenario(deps: HeapScenarioDeps): DevScenarioDef {
	return {
		id: "resources.heap-pressure",
		group: "state",
		title: "堆逼近上限",
		icon: "check",
		desc: "把本体堆占比换成指定值。占比、环的颜色、近 5 分钟曲线与「已逼近堆上限」那条 warn 全照真的算一遍;收摊即回真读数。",
		params: [
			{
				key: "ratio",
				label: "堆占比(%)",
				kind: "number",
				default: DEFAULT_RATIO,
				min: 0,
				max: 100,
			},
		],
		run(params) {
			const raw = typeof params.ratio === "number" ? params.ratio : DEFAULT_RATIO;
			deps.heap.inject(raw / 100);
			return {};
		},
		active() {
			const ratio = deps.heap.injected();
			if (ratio === null) return null;
			return {
				scenarioId: "resources.heap-pressure",
				label: `堆占比 → ${Math.round(ratio * 100)}%`,
			};
		},
		reset() {
			deps.heap.clear();
		},
	};
}
