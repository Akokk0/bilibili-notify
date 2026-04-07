import type { Context } from "@koishijs/client";
// biome-ignore lint/correctness/noUnusedImports: module augmentation
import {} from "@koishijs/plugin-console";

declare module "@koishijs/plugin-console" {
	namespace Console {
		interface Services {
			"bilibili-notify": import("@koishijs/plugin-console").DataService<{
				status: number;
				msg: string;
				// biome-ignore lint/suspicious/noExplicitAny: dynamic data shape
				data?: any;
			}>;
		}
	}
}

import Settings from "./settings.vue";

export default (ctx: Context) => {
	ctx.slot({
		type: "plugin-details",
		component: Settings,
		order: 0,
	});
};
