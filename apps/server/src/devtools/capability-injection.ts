import type { AdapterCapabilities } from "@bilibili-notify/internal";
import type { PlatformAdapter } from "../platforms/types.js";

/**
 * B3:适配器能力注入。`PlatformAdapter.capabilities` / `probeCapabilities` 外面套一层:
 * 对注入过的 adapter id 回假的(探一次也回假的、不出网),别的原样。
 *
 * 没有能力概念的平台(没实现这两个方法的)不碰:面板上「这个平台不支持」靠的正是方法
 * 不在,给它补上等于替 webhook 也声明了能力。与截流闸叠着用:`caps.wrap(gate.wrap(a))`。
 */
export interface CapabilityInjector {
	set(adapterId: string, caps: AdapterCapabilities): void;
	clear(adapterId?: string): void;
	entries(): Array<[string, AdapterCapabilities]>;
	wrap(inner: PlatformAdapter): PlatformAdapter;
}

export function createCapabilityInjector(): CapabilityInjector {
	const fakes = new Map<string, AdapterCapabilities>();
	return {
		set(adapterId, caps) {
			fakes.set(adapterId, caps);
		},
		clear(adapterId) {
			if (adapterId === undefined) fakes.clear();
			else fakes.delete(adapterId);
		},
		entries: () => [...fakes.entries()],
		wrap(inner) {
			const { capabilities, probeCapabilities } = inner;
			// 没有能力概念的平台(webhook)原样交回:替它补上等于替它声明了能力。
			if (!capabilities && !probeCapabilities) return inner;
			// 展开而不是逐个转发:别的方法有就有、没有就没有,接口多一个方法这里也不用跟。
			// 前提是 adapter 的方法不吃 `this`,那条写在 PlatformAdapter 的文档上。
			const wrapped: PlatformAdapter = { ...inner };
			if (capabilities) {
				wrapped.capabilities = (adapter) => fakes.get(adapter.id) ?? capabilities(adapter);
			}
			if (probeCapabilities) {
				wrapped.probeCapabilities = async (adapter) =>
					fakes.get(adapter.id) ?? probeCapabilities(adapter);
			}
			return wrapped;
		},
	};
}
