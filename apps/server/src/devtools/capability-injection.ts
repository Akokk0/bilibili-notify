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
			const { capabilities, probeCapabilities, reconcile, dispose } = inner;
			if (!capabilities && !probeCapabilities) return inner;
			const wrapped: PlatformAdapter = {
				platforms: inner.platforms,
				send: (a, t, p, o) => inner.send(a, t, p, o),
				isAvailable: (a, t) => inner.isAvailable(a, t),
				probe: (a) => inner.probe(a),
			};
			if (capabilities) {
				wrapped.capabilities = (adapter) =>
					fakes.get(adapter.id) ?? capabilities.call(inner, adapter);
			}
			if (probeCapabilities) {
				wrapped.probeCapabilities = async (adapter) =>
					fakes.get(adapter.id) ?? probeCapabilities.call(inner, adapter);
			}
			if (reconcile) wrapped.reconcile = (adapters) => reconcile.call(inner, adapters);
			if (dispose) wrapped.dispose = () => dispose.call(inner);
			return wrapped;
		},
	};
}
