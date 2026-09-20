/**
 * 皮肤库列表(`GET /api/card-skins`)的那一份 react-query 缓存,以及「换上这套」那个动作。
 *
 * 单独成模,是因为读它的地方已经有三处(皮肤库一节、per-UP 的「用哪套」下拉、旋钮区),
 * 而它们必须共用**同一个 key** —— 各写各的 key 等于各拉一趟,装完包只刷新其中一块。
 *
 * 「换上这套」同理,而且更容易漏:它要作废的是**两个** key(见 `useActivateCardSkin`),
 * 手抄一份必然有一处少抄。
 */

import type { CardSkinListResponse } from "@bilibili-notify/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../services/api";

/** 皮肤库列表的 react-query 键。 */
export const CARD_SKINS_KEY = ["card-skins"] as const;

export function useCardSkinList() {
	return useQuery({
		queryKey: CARD_SKINS_KEY,
		queryFn: () => api.get<CardSkinListResponse>("/api/card-skins"),
	});
}

/**
 * 启用某一套卡片皮肤(`PUT /api/card-skins/active`)。
 *
 * **它要作废两个 key,少一个就静默出错**:列表自己那份(`CARD_SKINS_KEY`,「使用中」
 * 徽标读的是它),以及 `["globals"]` —— **启用指针住在 `globals.defaults.cardSkin`,
 * 不在店里**,读 globals 的那些地方(卡片预览、灵动岛基线)不重取就还是旧的。
 *
 * 按这颗钮的地方现在有两处(皮肤库那一节、卡片工坊回复末尾的预览块),所以封在这里
 * 而不是各写一份:将来这个动作再多作废一个 key(比如预览缓存),漏掉的那一处的症状是
 * 「换了皮肤,聊天里的预览还是旧的」,而且不报错、不红。
 *
 * `onSuccess` / `onError` 留给调用方做它自己那半(清错、报错),invalidate 不归它管。
 */
export function useActivateCardSkin(
	opts: { onSuccess?: () => void; onError?: (message: string) => void } = {},
) {
	const qc = useQueryClient();
	return useMutation<{ ok: boolean }, Error, string>({
		mutationFn: (id) => api.put<{ ok: boolean }>("/api/card-skins/active", { id }),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: CARD_SKINS_KEY });
			void qc.invalidateQueries({ queryKey: ["globals"] });
			opts.onSuccess?.();
		},
		onError: (e) => opts.onError?.(String(e.message)),
	});
}
