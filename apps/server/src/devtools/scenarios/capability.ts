import type { Connection, ConnectionCapabilities } from "@bilibili-notify/internal";
import { RESERVED_INTEGRATION_KEYS } from "@bilibili-notify/internal";
import { routeConnection } from "../../push/dispatch.js";
import type { PlatformAdapterView } from "../../push/registry.js";
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
	 *
	 * **现取** —— 拓展是后加载的,拨一下开关就会来去(ADR-0012 决策 29);建表那一刻
	 * 取一次的话,拓展带来的方言在这张表里永远不存在。
	 */
	dialects: () => readonly CapabilityDialect[];
}

/** 方言里这个场景问的那几格;登记表对外给的视图(不含 `send`)也满足它。 */
type CapabilityDialect = Pick<
	PlatformAdapterView,
	"adapterKey" | "capabilities" | "probeCapabilities" | "settingsSchema"
>;

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
function capablePlatforms(dialects: readonly CapabilityDialect[]): Set<string> {
	const out = new Set<string>();
	for (const dialect of dialects) {
		if (!dialect.capabilities && !dialect.probeCapabilities) continue;
		out.add(dialect.adapterKey);
	}
	return out;
}

const DEFAULT_REASON = "devtools:假装 1404 不支持的动作";

/**
 * 假的只换 `miniAppCard` 这一格:`atAll` / `inbound` 沿用方言原本的回答(`base`)。
 * 整个对象换掉的话,注入期间 @全体 / 审批 / 链接解析设置读到的就全是「还不知道」了。
 */
function build(
	state: State,
	reason: string,
	base: ConnectionCapabilities | undefined,
): ConnectionCapabilities {
	const unknown = { state: "unknown" } as const;
	const keep = { atAll: base?.atAll ?? unknown, inbound: base?.inbound ?? unknown };
	switch (state) {
		case "supported":
			return { ...keep, miniAppCard: { state: "supported", checkedAt: Date.now() } };
		case "unsupported":
			return { ...keep, miniAppCard: { state: "unsupported", reason, checkedAt: Date.now() } };
		case "unknown":
			return { ...keep, miniAppCard: { state: "unknown" } };
	}
}

export function capabilityScenario(deps: CapabilityScenarioDeps): DevScenarioDef {
	return {
		id: "connection.capability",
		group: "state",
		title: "连接能力",
		icon: "sparkle",
		desc: "换掉某个连接「能不能签小程序卡」的探测结果(支持 / 不支持 / 未知)。探一次也回假的,不出网;只换小程序卡这一格,@全体 / 收回复沿用适配器自己的回答;没有能力概念的平台(没实现 capabilities 的)选不了。",
		params: [
			{ key: "connection", label: "连接", kind: "connection" },
			{ key: "state", label: "状态", kind: "enum", options: STATES, default: "supported" },
			{ key: "reason", label: "不支持的理由", kind: "text", default: DEFAULT_REASON },
		],
		run(params) {
			const capable = capablePlatforms(deps.dialects());
			const connections = deps.connections();
			const wanted = params.connection;
			const connection =
				wanted === undefined
					? connections.find((a) => capable.has(a.adapterKey))
					: connections.find((a) => a.id === String(wanted));
			if (!connection) {
				throw new DevParamError(
					wanted === undefined ? "没有有能力概念的连接" : `没有这个连接:${wanted}`,
				);
			}
			if (!capable.has(connection.adapterKey)) {
				throw new DevParamError(
					`${connection.name} 是 ${RESERVED_INTEGRATION_KEYS.includes(connection.adapterKey) ? connection.platform : connection.adapterKey},没有能力这回事`,
				);
			}
			const state = String(params.state ?? "supported") as State;
			const reason =
				typeof params.reason === "string" && params.reason !== "" ? params.reason : DEFAULT_REASON;
			// 走 routeConnection:递给适配器的连接 settings 要是解过的;被隔离的连接没有「真」能力可沿用。
			const route = routeConnection(deps.dialects(), connection);
			const base = route.ok ? route.adapter.capabilities?.(route.connection) : undefined;
			deps.injector.set(connection.id, build(state, reason, base));
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
