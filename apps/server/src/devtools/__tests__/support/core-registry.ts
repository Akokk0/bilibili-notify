import { createDevtoolsProviderRegistry } from "../../providers.js";
import {
	createDevRegistry,
	type DevRegistry,
	type DevRegistryOptions,
	type DevScenarioDef,
} from "../../registry.js";

/** 核心那一家交这些场景的注册表:id 加 `core.`,与 `createDevtools` 里建的同一个形状。 */
export function coreDevRegistry(
	defs: readonly DevScenarioDef[],
	options?: DevRegistryOptions,
): DevRegistry {
	return createDevRegistry(createDevtoolsProviderRegistry(defs), options);
}
