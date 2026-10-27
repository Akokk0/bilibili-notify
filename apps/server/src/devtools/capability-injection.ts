import type { ConnectionCapabilities } from "@bilibili-notify/internal";

/**
 * B3:连接能力注入。记下每条连接要假装的答案,由派发器经 `injectedCapabilities` 读口去取 ——
 * 它盖在宿主的「能力记忆」之上:注入期间读到的是这份假值,收摊后立刻回到真答案,假值不进记忆。
 * 探一次也走这个读口(不叫适配器、不出网)。
 */
export interface CapabilityInjector {
	set(connectionId: string, caps: ConnectionCapabilities): void;
	clear(connectionId?: string): void;
	entries(): Array<[string, ConnectionCapabilities]>;
	/** 派发器先问这里:这条连接有假值就整份换上。 */
	get(connectionId: string): ConnectionCapabilities | undefined;
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
		get: (connectionId) => fakes.get(connectionId),
	};
}
