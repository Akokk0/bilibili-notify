import { createDevtoolsProviderRegistry } from "../../../../devtools/providers.js";
import {
	createDevRegistry,
	type DevRegistry,
	type DevScenarioDef,
} from "../../../../devtools/registry.js";

/**
 * 测试里建注册表的方式与真入口一致:场景先登进登记表认领 `bilibili`,再由汇总出来的、带
 * `bilibili.` 前缀的那一份建注册表 —— 断言里的 id 就是面板上看到的 id。
 */
export function biliRegistry(scenarios: DevScenarioDef[]): DevRegistry {
	const providers = createDevtoolsProviderRegistry();
	providers.claim("bilibili", { scenarios });
	return createDevRegistry(providers.scenarios());
}
