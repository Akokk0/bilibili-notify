import type { DevInjection, DevParamValues, DevScenario } from "@bilibili-notify/contract";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useSyncExternalStore } from "react";

/**
 * devtools 的前端半边:与服务端同形状的声明 + 在浏览器里跑的 `run`(涌 toast、装不可达壳、
 * 灵动岛状态这类只存在于面板里的东西)。
 *
 * 两半共用一个 id 命名空间,面板把两张表并成一张;并的时候撞 id 直接炸 —— 静默盖掉一个的
 * 症状是「按了没反应」,查不出来。
 */
export interface WebRunContext {
	qc: QueryClient;
}

export interface WebDevScenario extends DevScenario {
	group: "web";
	/** 回一句回执(「涌了 6 条」)或什么都不回。 */
	run(params: DevParamValues, ctx: WebRunContext): Promise<string | undefined> | string | undefined;
	/** 状态类:现在生效着的那条注入(与服务端那半同形状),没有就 null。 */
	active?(): DevInjection | null;
	/** 状态类:收摊。 */
	reset?(): void;
	/**
	 * 状态类:这条注入所在的 store 变了就叫一声。生效表是从 store 现算的,而 store 会被
	 * **面板之外**的动作改掉(灵动岛上按「丢弃」、换一页把草稿注销)—— 没有这一条的话,
	 * 药丸上的呼吸点会继续宣称有一条早已不存在的注入,而那个点的全部意义就是「你看到的
	 * 不全是真的」,指错方向比不指更糟。
	 */
	subscribe?(onChange: () => void): () => void;
}

/** 前端半边的注册表本体在 `web-scenarios.ts`;这里只放并表与查找。 */
export { WEB_SCENARIOS } from "./web-scenarios";

/**
 * 前端那半的生效表 —— 从各自的 store **现算**,并订阅它们。面板之外的动作也会改掉这些
 * store(灵动岛按「丢弃」、换一页把草稿注销),镜像进 state 的话药丸会一直亮着一条
 * 早就不存在的注入。
 */
export function useWebActive(scenarios: readonly WebDevScenario[]): DevInjection[] {
	const subscribe = useCallback(
		(onChange: () => void) => {
			const offs = scenarios.map((s) => s.subscribe?.(onChange)).filter((f) => f !== undefined);
			return () => {
				for (const off of offs) off();
			};
		},
		[scenarios],
	);
	// `webActive` 每次都新建数组,`useSyncExternalStore` 会拿 `Object.is` 比 —— 直接给它
	// 会每帧都判定成变了。存一份快照,内容真变了才换。
	const snapshot = useRef<{ key: string; value: DevInjection[] }>({ key: "", value: [] });
	const getSnapshot = useCallback(() => {
		const next = webActive(scenarios);
		const key = JSON.stringify(next);
		if (key !== snapshot.current.key) snapshot.current = { key, value: next };
		return snapshot.current.value;
	}, [scenarios]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 面板里的一条:声明 + 它在哪一边跑。 */
export interface DevEntry {
	side: "server" | "web";
	decl: DevScenario;
}

export function mergeScenarios(
	server: readonly DevScenario[],
	web: readonly WebDevScenario[],
): DevEntry[] {
	const seen = new Set<string>();
	const out: DevEntry[] = [];
	const push = (entry: DevEntry) => {
		if (seen.has(entry.decl.id)) throw new Error(`devtools 场景 id 撞了:${entry.decl.id}`);
		seen.add(entry.decl.id);
		out.push(entry);
	};
	for (const decl of server) push({ side: "server", decl });
	for (const { run: _run, active: _active, reset: _reset, ...decl } of web) {
		push({ side: "web", decl });
	}
	return out;
}

export function findWebScenario(
	id: string,
	scenarios: readonly WebDevScenario[],
): WebDevScenario | undefined {
	return scenarios.find((s) => s.id === id);
}

/** 前端半边现在生效着的注入。 */
export function webActive(scenarios: readonly WebDevScenario[]): DevInjection[] {
	const out: DevInjection[] = [];
	for (const s of scenarios) {
		const injection = s.active?.();
		if (injection) out.push(injection);
	}
	return out;
}
