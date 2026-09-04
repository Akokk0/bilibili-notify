/**
 * 「这个推送目标现在算不算暂停」—— 一处判定,链接解析白名单与周报发送共用。
 *
 * 目标自己的「启用」开关关了,或它挂在一个已停用的适配器下面(投递层对这两种情况一律
 * 回不可达),都算暂停。主人定的语义是**两处同一个意思**:暂停的目标勾着也不生效 ——
 * 白名单里那个群不解析,周报发送时跳过。各写一份判定的话,迟早一处认适配器一处不认。
 */

import type { PushAdapter, PushTarget } from "@bilibili-notify/internal";

export function isTargetPaused(target: PushTarget, adapters: readonly PushAdapter[]): boolean {
	if (!target.enabled) return true;
	return !adapters.find((a) => a.id === target.adapterId)?.enabled;
}
