/**
 * 锐评里「这位是谁」—— 名字与平台(ADR-0020 决策 3 / 12)。生成(提示词里的名称 / 平台两列)、投递
 * (卡上的名字、兜底文案)、调度(日志与私聊里的那条叫什么)三处用的是这一份,各写一份的话同一位
 * UP 在提示词里、卡上、私聊里迟早叫成三个名字。
 *
 * 所有来源走同一条链(ADR-0019 决策 77):资料里的名字 → 来源的身份标签。身份标签只由来源描述符
 * 与装载器决定,B 站经自己的描述符仍叫 `UID xxx`,锐评这里不再按来源键分叉。
 */

import { displayNameOf, type UpStatsRow } from "@bilibili-notify/contract";
import {
	type Identity,
	type Subscription,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import type { RouteDeps } from "../routes/types.js";
import {
	type PlatformLabelDeps,
	platformLabelOf,
	subscriptionIdentityLabelOf,
} from "../subscriptions/platform-label.js";

export type RoastSubjectDeps = Pick<RouteDeps, "runtime">;

/** 锐评里的平台名与身份标签都要问同一组来源登记表和拓展装载器。 */
function platformDeps(deps: RoastSubjectDeps): PlatformLabelDeps {
	return {
		sources: deps.runtime.sourceRegistry,
		extensionPlatformLabel: (id) => deps.runtime.pipeline?.extensionPlatformLabel(id),
	};
}

/** 这条订阅在锐评里叫什么。见文件头的一条链。 */
export function roastSubjectName(deps: RoastSubjectDeps, sub: Subscription): string {
	const profileName = deps.runtime.subscriptionStateStore.get(sub.id)?.cachedProfile?.name;
	const identity = subscriptionIdentityOf(sub);
	return displayNameOf(
		{ profileName: profileName?.trim() },
		subscriptionIdentityLabelOf(identity, platformDeps(deps)),
	);
}

/**
 * 「平台」那一列(决策 12):在来源登记表里的来源(B 站、以后别的内置来源)写它描述符的 `label`;不在登记表里的
 * (拓展)写它清单里订阅源的平台名(推送链路现取,同女仆查订阅那份视图),取不到(拓展卸了、推送链路还没起来)写拓展 id ——
 * 同面板(ADR-0019 决策 10)。
 */
export function roastPlatformLabel(deps: RoastSubjectDeps, identity: Identity): string {
	return platformLabelOf(identity.sourceKey, platformDeps(deps));
}

/**
 * 统计行的名字:对得上订阅就走 {@link roastSubjectName};对不上(取完数到这一刻之间订阅被删了)按行上带的
 * 身份兜底成同一种身份标签,总得认得出是谁。
 */
export function roastRowName(
	deps: RoastSubjectDeps,
	row: UpStatsRow,
	sub: Subscription | undefined,
): string {
	if (sub) return roastSubjectName(deps, sub);
	return subscriptionIdentityLabelOf(row.identity, platformDeps(deps));
}
