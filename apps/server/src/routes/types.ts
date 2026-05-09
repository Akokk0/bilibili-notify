import type { ConfigStore } from "../config/store.js";
import type { AppRuntime } from "../runtime/bootstrap.js";

/**
 * Shared dependency bag passed to each route module's factory. Avoids a global
 * singleton; instead each `create<Foo>Route(deps)` closes over what it needs.
 */
export interface RouteDeps {
	runtime: AppRuntime;
	store: ConfigStore;
}
