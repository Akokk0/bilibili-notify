import type { FeatureKey } from "@bilibili-notify/internal";

/**
 * Map LivePushType numeric values to FeatureKey strings.
 *
 * 独立文件避免被 live-service.ts 的 koishi import 链拖累 — 单元测试可以 import
 * 本模块而不会触发 @koishijs/loader 等运行时只在 koishi 进程里能起的代码。
 *
 * LivePushType values: Live=0, StartBroadcasting=3, LiveGuardBuy=4,
 *   WordCloudAndLiveSummary=5, Superchat=6, UserDanmakuMsg=7, UserActions=8,
 *   LiveEnd=9, LiveSummary=10
 *
 * 必须与 `apps/server/src/runtime/engines.ts` 的同名函数保持一致 — 两端 adapter
 * 翻译表分歧会让同一业务核心在双端给出不同路由。
 */
export function liveTypeToFeature(type: number): FeatureKey {
	switch (type) {
		case 0:
		case 3:
			return "live";
		case 4:
			return "liveGuardBuy";
		case 5:
			return "wordcloud";
		case 6:
			return "superchat";
		case 7:
			return "specialDanmaku";
		case 8:
			return "specialUserEnter";
		case 9:
			return "liveEnd";
		case 10:
			return "liveSummary";
		default:
			return "live";
	}
}

/**
 * Whether a LivePushType is @全体成员-eligible.
 *
 * 仅 `StartBroadcasting`(=3,开播)允许 @全体;周期「正在直播」复推(`Live`=0)
 * 与其它都翻译成 `feature === "live"`,光看 feature 区分不出开播 vs 复推 —— push
 * 层据本结果决定是否进 atAll 分支,否则每条直播推送都 @全体(已修 bug)。
 * 用裸数字 3 而非 import `LivePushType` 是为保持本文件零依赖(见文件头说明);
 * 必须与 `apps/server/src/runtime/engines.ts` 的同名函数保持一致。
 */
export function liveTypeAllowsAtAll(type: number): boolean {
	return type === 3;
}
