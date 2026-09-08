import type { Connection, ConnectionCapabilities } from "@bilibili-notify/internal";
import { connectionDispatchKey } from "@bilibili-notify/internal";
import type { PlatformDialect } from "../../platforms/types.js";
import type { CapabilityInjector } from "../capability-injection.js";
import { DevParamError, type DevScenarioDef } from "../registry.js";

/**
 * B3:连接能力三态 —— 小程序卡 支持 / 不支持 / 未知。面板的能力探测面板、系统页支持面板、
 * 链接解析「形式」那一栏都从这儿读。
 */
export interface CapabilityScenarioDeps {
	injector: CapabilityInjector;
	connections: () => Connection[];
	/**
	 * 平台方言 —— 用来回答「哪些平台有能力这回事」。给**没包装过**的那份:能力注入的
	 * 装饰器今天会把没有能力概念的 adapter 原样交回(见 `capability-injection.ts`),
	 * 但那是它的实现细节;这里问的是方言本身有没有能力这回事,该问方言本人。
	 */
	dialects: readonly PlatformDialect[];
}

const STATES = [
	{ value: "supported", label: "支持小程序卡" },
	{ value: "unsupported", label: "不支持(带理由)" },
	{ value: "unknown", label: "未知(还没探)" },
] as const;

type State = (typeof STATES)[number]["value"];

/**
 * 有能力概念的平台 —— **问方言**,不在这儿写死平台名。
 *
 * 判据就是「这份方言实现了能力方法吗」:今天只有 OneBot 实现,所以答案还是它一家。
 * 写死一个 `new Set(["onebot"])` 的问题不是今天答错,是哪天给官机接上能力探测之后,
 * devtools 会**继续说它没有能力这回事** —— 而这种错没有任何东西会报。
 */
function capablePlatforms(dialects: readonly PlatformDialect[]): Set<string> {
	const out = new Set<string>();
	for (const dialect of dialects) {
		if (!dialect.capabilities && !dialect.probeCapabilities) continue;
		for (const platform of dialect.platforms) out.add(platform);
	}
	return out;
}

const DEFAULT_REASON = "devtools:假装 1404 不支持的动作";

function build(state: State, reason: string): ConnectionCapabilities {
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
		id: "connection.capability",
		group: "state",
		title: "连接能力",
		icon: "sparkle",
		desc: "换掉某个连接「能不能签小程序卡」的探测结果(支持 / 不支持 / 未知)。探一次也回假的,不出网;没有能力概念的平台选不了 —— 今天只有 OneBot 有。",
		params: [
			{ key: "connection", label: "连接", kind: "connection" },
			{ key: "state", label: "状态", kind: "enum", options: STATES, default: "supported" },
			{ key: "reason", label: "不支持的理由", kind: "text", default: DEFAULT_REASON },
		],
		run(params) {
			const capable = capablePlatforms(deps.dialects);
			const connections = deps.connections();
			const wanted = params.connection;
			const connection =
				wanted === undefined
					? connections.find((a) => capable.has(connectionDispatchKey(a)))
					: connections.find((a) => a.id === String(wanted));
			if (!connection) {
				throw new DevParamError(
					wanted === undefined ? "没有有能力概念的连接" : `没有这个连接:${wanted}`,
				);
			}
			if (!capable.has(connectionDispatchKey(connection))) {
				throw new DevParamError(
					`${connection.name} 是 ${connectionDispatchKey(connection)},没有能力这回事`,
				);
			}
			const state = String(params.state ?? "supported") as State;
			const reason =
				typeof params.reason === "string" && params.reason !== "" ? params.reason : DEFAULT_REASON;
			deps.injector.set(connection.id, build(state, reason));
			return {};
		},
		active() {
			const entries = deps.injector.entries();
			if (entries.length === 0) return null;
			const connections = deps.connections();
			const label = entries
				.map(([id, caps]) => {
					const name = connections.find((a) => a.id === id)?.name ?? id;
					const state =
						STATES.find((s) => s.value === caps.miniAppCard.state)?.label ?? caps.miniAppCard.state;
					return `${name} ${state}`;
				})
				.join(" / ");
			return { scenarioId: "connection.capability", label: `能力 → ${label}` };
		},
		reset() {
			deps.injector.clear();
		},
	};
}
