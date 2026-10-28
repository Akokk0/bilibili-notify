import type { PlatformAdapterDescriptor } from "@bilibili-notify/internal";

/**
 * 假适配器的描述占位:`PlatformAdapter.descriptor` 是必备成员,而用它的测试不看适配器的脸。
 * 要看脸的(适配器表读口、问题引子)自己写一份。
 */
export function placeholderDescriptor(label = "测试适配器"): () => PlatformAdapterDescriptor {
	return () => ({ label, shortLabel: label, color: "#000000", settingsFields: [] });
}
