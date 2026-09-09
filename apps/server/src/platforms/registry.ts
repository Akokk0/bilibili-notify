import type { Disposable } from "@bilibili-notify/internal";
import type { PlatformAdapter } from "./types.js";

/**
 * 推送出口的**活注册表** —— adapter 矩阵的家(ADR-0012 决策 29)。
 *
 * 从前这是一个开机拼好的数组。拓展是后加载的、而且要能被拨开关加载 / 卸载,定死的数组
 * 两件事都干不了:两段式装配(先加载拓展再拼数组)会把「启用 / 停用不重启」作废,而往一个
 * 共享数组里 push 有一颗**只在开发版炸**的雷 —— dev 下拿到的是 devtools 包过一层的**另一
 * 份**,往原数组 push 的话开发版里根本看不见,两边都不报错。
 */
export interface AdapterRegistry {
	/**
	 * 注册一个出口,回一个撤下它的把手。
	 *
	 * 它认领的每一个分发键都得是空的,**占了就抛**:悄悄顶掉等于把别人的连接整个截走
	 * (一个拓展要是能声明 `"onebot"`,内置那条连接的推送就全走它了),而两边都不报错。
	 */
	register(adapter: PlatformAdapter): Disposable;
	/**
	 * 现在有哪些出口。
	 *
	 * 🔴 **在分发那一刻问**,别把结果存下来 —— 存一份就等于回到那个开机拼好的数组,
	 * 后注册的拓展对它永远不存在。
	 */
	list(): readonly PlatformAdapter[];
}

export function createAdapterRegistry(initial: readonly PlatformAdapter[] = []): AdapterRegistry {
	const adapters: PlatformAdapter[] = [];
	const keys = new Set<string>();

	function add(adapter: PlatformAdapter): void {
		for (const key of adapter.platforms) {
			if (keys.has(key)) throw new Error(`adapter for dispatch key "${key}" is already registered`);
		}
		for (const key of adapter.platforms) keys.add(key);
		adapters.push(adapter);
	}

	for (const adapter of initial) add(adapter);

	return {
		list: () => adapters,
		register(adapter) {
			add(adapter);
			let removed = false;
			return {
				dispose() {
					if (removed) return;
					removed = true;
					const idx = adapters.indexOf(adapter);
					if (idx >= 0) adapters.splice(idx, 1);
					for (const key of adapter.platforms) keys.delete(key);
				},
			};
		},
	};
}
