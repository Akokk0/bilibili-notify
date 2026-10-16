import type { ConnectionCapabilities } from "@bilibili-notify/internal";
import { pickAdapterMembers } from "../push/adapter-members.js";
import type { PlatformAdapterView } from "../push/registry.js";

/**
 * B3:连接能力注入。`PlatformAdapter.capabilities` / `probeCapabilities` 外面套一层:
 * 对注入过的 adapter id 回假的(探一次也回假的、不出网),别的原样。
 *
 * 没有能力概念的平台(没实现这两个方法的)不碰:面板上「这个平台不支持」靠的正是方法
 * 不在,给它补上等于替 webhook 也声明了能力。只见得到不含 `send` 的视图(发送归出口咽喉)。
 */
export interface CapabilityInjector {
	set(connectionId: string, caps: ConnectionCapabilities): void;
	clear(connectionId?: string): void;
	entries(): Array<[string, ConnectionCapabilities]>;
	wrap(inner: PlatformAdapterView): PlatformAdapterView;
}

export function createCapabilityInjector(): CapabilityInjector {
	const fakes = new Map<string, ConnectionCapabilities>();
	return {
		set(connectionId, caps) {
			fakes.set(connectionId, caps);
		},
		clear(connectionId) {
			if (connectionId === undefined) fakes.clear();
			else fakes.delete(connectionId);
		},
		entries: () => [...fakes.entries()],
		wrap(inner) {
			// 没有能力概念的平台(webhook)原样交回:替它补上等于替它声明了能力。
			if (!inner.capabilities && !inner.probeCapabilities) return inner;
			// 按成员表取、方法 bind 回 `inner`:别的方法有就有、没有就没有,接口多一个方法这里也不用跟,
			// class 写的适配器也不会因为脱离实例而丢状态。下面读出来的两个已经是 bind 好的。
			const wrapped: PlatformAdapterView = pickAdapterMembers(inner, []);
			const { capabilities, probeCapabilities } = wrapped;
			if (capabilities) {
				wrapped.capabilities = (connection) => fakes.get(connection.id) ?? capabilities(connection);
			}
			if (probeCapabilities) {
				wrapped.probeCapabilities = async (connection) =>
					fakes.get(connection.id) ?? probeCapabilities(connection);
			}
			return wrapped;
		},
	};
}
