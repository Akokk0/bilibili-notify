import type { QueryClient } from "@tanstack/react-query";
import { checkUpdateOnOpen } from "../hooks/useUpdateCheckOnOpen";
import { useToastStore } from "../store/notifications";

/**
 * 服务端场景跑完之后,面板这边要**跟着补做**的事。
 *
 * 绝大多数造出来的状态,面板上的消费点都是靠查询看到的 —— 跑完把所有查询作废就够了。
 * 例外是那些只在某个**时机**才出手的消费点:「有新版」通知卡只在打开面板那次自动检查里发
 * (`useUpdateCheckOnOpen`),之后状态怎么变它都不再出声。注入 `available` 之后不刷新页面
 * 就看不到那张卡,而「造完立刻看到」正是 devtools 的用处。
 *
 * 补做的方式是把那个时机**重放**一遍:调的是同一个函数、走的是同一条路(拉状态 → POST
 * check → 判有没有新版 → 发卡),不另造一条发卡的路 —— 否则卡的措辞就有了两处来源。
 */
export type DevFollowUp = (qc: QueryClient) => Promise<void>;

export const FOLLOW_UPS: Readonly<Record<string, DevFollowUp>> = {
	"update.state": (qc) => checkUpdateOnOpen(qc, useToastStore.getState().notify),
};
