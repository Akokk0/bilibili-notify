import { PROMPT_NEUTRAL_NOUNS } from "@bilibili-notify/ai";
import type { SourceNouns } from "@bilibili-notify/contract";
import type { RouteDeps } from "../routes/types.js";
import { sourceNounsFor } from "../subscriptions/platform-label.js";

/** 提示词叫法的现取口:宿主手边是 `RouteDeps` 的几处(试一句、锐评、技能读口)共用这一份,取法只在 `sourceNounsFor`。 */
export function promptNounsOf(
	deps: Pick<RouteDeps, "runtime" | "store">,
): (sourceKeys?: readonly string[]) => SourceNouns {
	return (keys) =>
		sourceNounsFor(
			keys,
			{
				sources: deps.runtime.sourceRegistry,
				extensionPlatformLabel: (id) => deps.runtime.engines?.extensionPlatformLabel(id),
				extensionPostNoun: (id) => deps.runtime.engines?.extensionPostNoun(id),
				subscriptions: () => deps.store.getSubscriptions(),
			},
			PROMPT_NEUTRAL_NOUNS,
		);
}
