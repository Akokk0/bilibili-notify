import type { IntegrationContext } from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";

/** 核心有效时区的共同读源;每份订阅以订阅当刻为去重基线。 */
export function timezoneReaderOf(
	store: Pick<ConfigStore, "getGlobals" | "onChange">,
): Pick<IntegrationContext, "timezone" | "onTimezoneChanged"> {
	return {
		timezone: () => store.getGlobals().timezone,
		onTimezoneChanged(fn) {
			let active = true;
			let last = store.getGlobals().timezone;
			const watch = store.onChange((scope) => {
				if (!active || scope !== "globals") return;
				const next = store.getGlobals().timezone;
				if (next === last) return;
				last = next;
				fn();
			});
			return {
				dispose() {
					if (!active) return;
					active = false;
					watch.dispose();
				},
			};
		},
	};
}
