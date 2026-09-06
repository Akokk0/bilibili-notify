import type { AdapterCapabilities, PushAdapter } from "@bilibili-notify/internal";
import type { CapabilityInjector } from "../capability-injection.js";
import { DevParamError, type DevScenarioDef } from "../registry.js";

/**
 * B3:适配器能力三态 —— 小程序卡 支持 / 不支持 / 未知。面板的能力探测面板、系统页支持面板、
 * 链接解析「形式」那一栏都从这儿读。
 */
export interface CapabilityScenarioDeps {
	injector: CapabilityInjector;
	adapters: () => PushAdapter[];
}

const STATES = [
	{ value: "supported", label: "支持小程序卡" },
	{ value: "unsupported", label: "不支持(带理由)" },
	{ value: "unknown", label: "未知(还没探)" },
] as const;

type State = (typeof STATES)[number]["value"];

/** 有能力概念的平台:今天就 OneBot 一家(官机 / webhook 没有)。 */
const CAPABLE_PLATFORMS = new Set(["onebot"]);
const DEFAULT_REASON = "devtools:假装 1404 不支持的动作";

function build(state: State, reason: string): AdapterCapabilities {
	switch (state) {
		case "supported":
			return { miniAppCard: { state: "supported", checkedAt: Date.now() } };
		case "unsupported":
			return { miniAppCard: { state: "unsupported", reason, checkedAt: Date.now() } };
		case "unknown":
			return { miniAppCard: { state: "unknown" } };
	}
}

export function capabilityScenario(deps: CapabilityScenarioDeps): DevScenarioDef {
	return {
		id: "adapter.capability",
		group: "state",
		title: "适配器能力",
		icon: "sparkle",
		desc: "换掉某个 OneBot 适配器「能不能签小程序卡」的探测结果(支持 / 不支持 / 未知)。探一次也回假的,不出网;官机 / webhook 没有能力概念,选不了。",
		params: [
			{ key: "adapter", label: "适配器", kind: "adapter" },
			{ key: "state", label: "状态", kind: "enum", options: STATES, default: "supported" },
			{ key: "reason", label: "不支持的理由", kind: "text", default: DEFAULT_REASON },
		],
		run(params) {
			const adapters = deps.adapters();
			const wanted = params.adapter;
			const adapter =
				wanted === undefined
					? adapters.find((a) => CAPABLE_PLATFORMS.has(a.platform))
					: adapters.find((a) => a.id === String(wanted));
			if (!adapter) {
				throw new DevParamError(
					wanted === undefined ? "没有 OneBot 适配器" : `没有这个适配器:${wanted}`,
				);
			}
			if (!CAPABLE_PLATFORMS.has(adapter.platform)) {
				throw new DevParamError(`${adapter.name} 是 ${adapter.platform},没有能力这回事`);
			}
			const state = String(params.state ?? "supported") as State;
			const reason =
				typeof params.reason === "string" && params.reason !== "" ? params.reason : DEFAULT_REASON;
			deps.injector.set(adapter.id, build(state, reason));
			return {};
		},
		active() {
			const entries = deps.injector.entries();
			if (entries.length === 0) return null;
			const adapters = deps.adapters();
			const label = entries
				.map(([id, caps]) => {
					const name = adapters.find((a) => a.id === id)?.name ?? id;
					const state =
						STATES.find((s) => s.value === caps.miniAppCard.state)?.label ?? caps.miniAppCard.state;
					return `${name} ${state}`;
				})
				.join(" / ");
			return { scenarioId: "adapter.capability", label: `能力 → ${label}` };
		},
		reset() {
			deps.injector.clear();
		},
	};
}
