import { ok } from "@bilibili-notify/internal";
import {
	createIntegrationSettings,
	type settingsReaderOptionsOf,
} from "../../integrations/settings-reader.js";
import { silentLogger } from "./silent-logger.js";

/**
 * 设置读法的哑实现:每个集成读到的都是一份空设置(`{}`),从不说「变了」。给那些不关心设置、只是得递一份
 * (造集成上下文要的必填项)的测试用 —— 要测设置怎么读、怎么变的,自己递读法。
 */
export const inertSettingsOf: ReturnType<typeof settingsReaderOptionsOf> = () => ({
	read: () => ok({ settings: {} }),
	onChanged: () => ({ dispose() {} }),
});

/** 造集成上下文要的 `settings` 选项,读到的是空设置。 */
export function inertSettings(): ReturnType<typeof createIntegrationSettings> {
	return createIntegrationSettings({ ...inertSettingsOf("inert"), logger: silentLogger });
}
