import { z } from "zod";

/**
 * AI 写正文(ADR-0032):正文用 AI 写还是用模板写,按推送目标选。动态(`post`,AI 点评 / 动态文案模板)
 * 与直播总结(`liveSummary`,AI 总结 / 总结模板)各一份,形状同链接预览那张表的「默认行 + 例外」两格:
 *
 * - `isOnByDefault` —— 默认行。默认开,升级后的行为与今天一样(开着 AI 就写)。
 * - `byTarget` —— 逐目标例外,键是推送目标 id(`PushTarget.id`),值是这个目标用不用 AI 正文,
 *   两个方向都能例外;没写的目标跟默认行。悬空的 id(目标后来删了)不在这里校验,运行时直接忽略。
 *   值是布尔,没有「空条目」可剥:删一条例外是面板发 `null`,`deepMerge` 把键删掉,不会走到 schema。
 *
 * 全仓的 `enabled` 只表示总开关,所以这里的默认行不叫 `enabled`(它没有总开关:AI 写不写由 `ai.enabled` 管)。
 * 它不进 `defaults`(不按订阅覆盖);开播、下播等其余直播文案没有 AI,不在这里。
 */
const AiWritingEntrySchema = z.object({
	isOnByDefault: z.boolean().default(true),
	byTarget: z.record(z.uuid(), z.boolean()).default({}),
});

// 默认值一律写成工厂:zod 4 的 `.default(值)` 只浅拷贝一层,嵌着的 byTarget 会被每次解析共用
// (`defaults-not-shared.test.ts` 钉着)。
export const AiWritingSettingsSchema = z.object({
	post: AiWritingEntrySchema.default(() => ({ isOnByDefault: true, byTarget: {} })),
	liveSummary: AiWritingEntrySchema.default(() => ({ isOnByDefault: true, byTarget: {} })),
});
export type AiWritingSettings = z.infer<typeof AiWritingSettingsSchema>;

/**
 * 这个目标用不用 AI 正文:例外里写了听例外(开关两个方向都行),没写用 `isOnByDefault`。
 * `entry` 是 `writing.post` 或 `writing.liveSummary` 那一份。
 */
export function aiWritingFor(entry: AiWritingSettings["post"], targetId: string): boolean {
	return entry.byTarget[targetId] ?? entry.isOnByDefault;
}

/**
 * 要不要去生成 AI 正文:默认开着,或现在还在的目标里有哪个的例外是开。`targetIds` 是现存目标的 id,
 * 指向已删目标的例外键不算数(悬空的 id 运行时忽略)。
 */
export function aiWritingNeeded(
	entry: AiWritingSettings["post"],
	targetIds: Iterable<string>,
): boolean {
	if (entry.isOnByDefault) return true;
	for (const id of targetIds) if (entry.byTarget[id] === true) return true;
	return false;
}
