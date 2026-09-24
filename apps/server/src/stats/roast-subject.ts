/**
 * 锐评里「这位是谁」—— 名字与平台(ADR-0020 决策 3 / 12)。生成(提示词里的名称 / 平台两列)、投递
 * (卡上的名字、兜底文案)、调度(日志与私聊里的那条叫什么)三处用的是这一份,各写一份的话同一位
 * UP 在提示词里、卡上、私聊里迟早叫成三个名字。
 *
 * 两支订阅在这里分流:
 * - **B 站**照旧:资料里的名字 → `UID xxx`(改之前锐评就是这条链,一个字不动)。
 * - **拓展**走卡片与历史那同一条链(ADR-0019 决策 77,少了事件里的作者名):资料里的名字 → 主人起的
 *   别名 → 外部 id(`extensionSubscriptionName`)。
 */

import type { UpStatsRow } from "@bilibili-notify/contract";
import { isBiliSubscription, type Subscription } from "@bilibili-notify/internal";
import type { RouteDeps } from "../routes/types.js";
import { extensionSubscriptionName } from "../runtime/extension-push-common.js";

export type RoastSubjectDeps = Pick<RouteDeps, "runtime">;

/** B 站那一支在「平台」一列里的写法。 */
export const BILIBILI_PLATFORM_LABEL = "B 站";

/** 这条订阅在锐评里叫什么。见文件头的两条链。 */
export function roastSubjectName(deps: RoastSubjectDeps, sub: Subscription): string {
	const profileName = deps.runtime.subRuntimeStore.get(sub.id)?.cachedProfile?.name;
	if (isBiliSubscription(sub)) return profileName?.trim() || `UID ${sub.uid}`;
	return extensionSubscriptionName(sub, { profileName });
}

/**
 * 「平台」那一列(决策 12):B 站写「B 站」;拓展写它清单里订阅源的平台名(引擎现取,同女仆查订阅那份
 * 视图),取不到(拓展卸了、引擎还没起来)写拓展 id —— 同面板(ADR-0019 决策 10)。
 */
export function roastPlatformLabel(
	deps: RoastSubjectDeps,
	identity: { uid?: string; extensionId?: string },
): string {
	if (identity.extensionId === undefined) return BILIBILI_PLATFORM_LABEL;
	return deps.runtime.engines?.extensionPlatformLabel(identity.extensionId) ?? identity.extensionId;
}

/**
 * 统计行的名字:对得上订阅就走 {@link roastSubjectName};对不上(取完数到这一刻之间订阅被删了)按行上带的
 * 身份兜底 —— B 站写 `UID xxx`、拓展写外部 id,总得认得出是谁。
 */
export function roastRowName(
	deps: RoastSubjectDeps,
	row: UpStatsRow,
	sub: Subscription | undefined,
): string {
	if (sub) return roastSubjectName(deps, sub);
	return row.externalId ?? `UID ${row.uid ?? row.subscriptionId}`;
}
