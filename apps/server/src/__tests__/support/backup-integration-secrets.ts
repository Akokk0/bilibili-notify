/**
 * 备份服务测试用的「集成密钥存储」桩:`exportSecrets` / `isOpen` / `restoreSecrets` 三样。
 *
 * 🔴 **桩不许什么都回成功** —— 「备份里有三个、现在开着两个 → 分两堆」「恢复失败的那一个进没带回来」这类用例,
 * 桩要是永远回成功就永远是绿的。所以:
 * - `isOpen` 只认用例给的 `open`(不给 = 一个都没开);
 * - `restoreSecrets` 由用例的 `restore` 给定;不给的用例里谁调了它就抛,当场红(那条用例本来就不该走到恢复)。
 */

import type { Json, Result } from "@bilibili-notify/internal";
import { vi } from "vite-plus/test";
import type { BackupIntegrationSecrets } from "../../backup/service.js";

export interface FakeIntegrationSecretsOptions {
	/** `exportSecrets` 交回的东西(集成键 → 整袋)。 */
	exported?: Record<string, Record<string, Json>>;
	/** 现在开着的集成键。 */
	open?: readonly string[];
	/** 恢复一个集成的密钥时回什么;不给 = 不该被调用。 */
	restore?: (key: string, entries: Record<string, Json>) => Result | Promise<Result>;
}

export function fakeIntegrationSecrets(opts: FakeIntegrationSecretsOptions = {}) {
	const open = new Set(opts.open ?? []);
	const secrets = {
		exportSecrets: vi.fn(async () => structuredClone(opts.exported ?? {})),
		isOpen: vi.fn((key: string) => open.has(key)),
		restoreSecrets: vi.fn(async (key: string, entries: Record<string, Json>): Promise<Result> => {
			if (!opts.restore) {
				throw new Error(`这条用例没有给定 restore,不该有人恢复 ${key} 的密钥`);
			}
			return opts.restore(key, entries);
		}),
	} satisfies BackupIntegrationSecrets;
	return secrets;
}
