import { packageText } from "@bilibili-notify/internal/texts";
import { parseCreator } from "./creator";
import type { PromptNouns } from "./prompt-nouns";

/**
 * 核心自带工具(含联网搜索、看图)给人看的标签 —— 聊天里那条「她正在查什么」小条上的字。
 *
 * 译文住包字典,这里在出字时取;怎么取、怎么拼见 `tools.ts` 的
 * `coreToolLabelOf` / `describeToolCall`。注入的那几把工具(读技能、做皮肤、卡片工坊)
 * 的标签在服务端各家旁边,不在这里。
 *
 * `labelArg`:这里**单独写**的格,优先于工具定义里 `required` 的格(`coreToolLabelOf` 把必填格
 * 接在后面)—— UP 主相关的几个都优先显示昵称,模型手里常常两个都有,而「咩栗」比一串数字
 * 好认得多;没给昵称时由必填的那一格兜底。必填格不必在这里重抄一遍。`format` 只翻那一格的值。
 */

/** `creator`(来源键:外部 id)在小条上只显示外部 id —— 切冒号不认任何平台;切不出就原样。 */
const externalIdOf = (creator: string): string => parseCreator(creator)?.externalId ?? creator;

export function coreToolLabelTexts(
	nouns: Pick<PromptNouns, "creatorNoun" | "postNoun"> = {
		creatorNoun: packageText("ai.tools.creatorNoun"),
		postNoun: packageText("ai.tools.postNoun"),
	},
): Readonly<
	Record<
		string,
		{ label: string; labelArg?: { keys: readonly string[]; format?: (value: string) => string } }
	>
> {
	return {
		list_subscriptions: { label: packageText("ai.tools.listSubscriptions") },
		get_live_status: { label: packageText("ai.tools.liveStatus") },
		get_creator_posts: {
			label: packageText("ai.tools.creatorPosts", { postNoun: nouns.postNoun }),
			labelArg: { keys: ["creator"], format: externalIdOf },
		},
		get_creator_profile: {
			label: packageText("ai.tools.creatorProfile", { creatorNoun: nouns.creatorNoun }),
			labelArg: { keys: ["creator"], format: externalIdOf },
		},
		get_creator_stats: {
			label: packageText("ai.tools.creatorStats"),
			labelArg: { keys: ["creator"], format: externalIdOf },
		},
		search_creators: {
			label: packageText("ai.tools.searchCreators"),
			labelArg: { keys: ["query"] },
		},
		// 联网搜索。转圈态就是「联网搜索「关键词」」—— 搜了什么比搜过有用。
		web_search: { label: packageText("ai.tools.webSearch") },
		describe_image: { label: packageText("ai.tools.describeImage") },
	};
}
