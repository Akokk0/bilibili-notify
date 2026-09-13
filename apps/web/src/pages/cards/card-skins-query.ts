/**
 * 皮肤库列表(`GET /api/card-skins`)的那一份 react-query 缓存。
 *
 * 单独成模,是因为读它的地方已经有三处(皮肤库一节、per-UP 的「用哪套」下拉、旋钮区),
 * 而它们必须共用**同一个 key** —— 各写各的 key 等于各拉一趟,装完包只刷新其中一块。
 */

import type { CardSkinListResponse } from "@bilibili-notify/contract";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../services/api";

/** 皮肤库列表的 react-query 键。 */
export const CARD_SKINS_KEY = ["card-skins"] as const;

export function useCardSkinList() {
	return useQuery({
		queryKey: CARD_SKINS_KEY,
		queryFn: () => api.get<CardSkinListResponse>("/api/card-skins"),
	});
}
