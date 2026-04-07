import type { Context } from "@koishijs/client";
import Settings from "./Settings.vue";

export default (ctx: Context) => {
	ctx.slot({
		type: "plugin-details",
		component: Settings,
		order: 0,
	});
};
