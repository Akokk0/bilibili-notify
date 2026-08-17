/**
 * 「服务端双槽 → store」的唯一一条回灌路径。
 *
 * 皮肤页启用 / 停用 / 删除之后走它;聊天里女仆做完一套皮肤(她可能顺手就替主人
 * 换上了)也走它。各处各写一份的话,新入口迟早漏掉同步 —— 症状是「明明换了皮肤,
 * 界面纹丝不动,刷新才好」,而那时最不像是少了一次 GET。
 */

import type { ActiveSkinResponse } from "@bilibili-notify/contract";
import { useSkinStore } from "../store/skin";
import { api } from "./api";

export async function syncActiveSkinToStore(): Promise<void> {
	const res = await api.get<ActiveSkinResponse>("/api/skins/active");
	useSkinStore.getState().setActive(res.active);
}
