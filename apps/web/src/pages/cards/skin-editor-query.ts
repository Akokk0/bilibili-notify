/**
 * 编辑器要的那两趟请求:**读一套皮肤的完整清单**(`GET /api/card-skins/:id`)与
 * **就地保存**(`PUT /api/card-skins/:id`)。
 *
 * 与 `card-skins-query.ts` 分开是因为读的不是同一样东西:那份是**列表**(每套只几个
 * 字段,三处共用一份缓存),这份是**某一套的整份清单**(块、CSS、资产名单),只有编辑器
 * 要,而且一次只看一套。共用一个 key 的话打开编辑器就会把列表那份挤掉。
 */

import type {
	CardSkinManifestResponse,
	CardSkinPreviewResponse,
	CardSkinSaveResponse,
	CardSkinShotResponse,
} from "@bilibili-notify/contract";
import type { CardSkinKind } from "@bilibili-notify/internal";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../services/api";
import { CARD_SKINS_KEY } from "./card-skins-query";

/** 某一套皮肤完整清单的 react-query 键。 */
export const cardSkinManifestKey = (id: string) => ["card-skin-manifest", id] as const;

/**
 * 某一套皮肤的完整清单。`enabled` 是给**出厂那份**留的口:接管一种卡时要抄它,而多数
 * 时候用不上 —— 每开一次编辑器都白打一趟不值当。
 */
export function useCardSkinManifest(id: string, enabled = true) {
	return useQuery({
		queryKey: cardSkinManifestKey(id),
		queryFn: () => api.get<CardSkinManifestResponse>(`/api/card-skins/${id}`),
		enabled,
		// 清单是编辑器的**正本**:窗口切回来时重拉会把主人正在编的草稿基线换掉,
		// 「有没有未保存的改动」当场算错。只在进页面时拉一次。
		refetchOnWindowFocus: false,
		staleTime: Number.POSITIVE_INFINITY,
	});
}

export function useSaveCardSkin(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (manifest: unknown) =>
			api.put<CardSkinSaveResponse>(`/api/card-skins/${id}`, manifest),
		onSuccess: () => {
			// 存完两份都过期:列表里那一行的名字 / 旋钮声明可能刚被改掉(旋钮区照它画控件),
			// 清单本身也要换成**服务端清洗之后**那一份 —— 编辑器显示的必须是存进去的东西。
			void qc.invalidateQueries({ queryKey: CARD_SKINS_KEY });
			void qc.invalidateQueries({ queryKey: cardSkinManifestKey(id) });
		},
	});
}

/**
 * **有没有 Chrome**(`GET /api/cards/render-source`)。「最终效果」得靠它 —— 没有就把钮
 * 禁掉并说清楚该去配什么,而不是让主人按下去吃一个 503。
 *
 * 与系统页「卡片渲染浏览器」那一区问的是同一个端点,但那边是直接 `api.get`、不走
 * react-query,所以两处**没有**共用缓存。这里不去追它:配 Chrome 的入口在另一页,
 * 主人配完再回编辑器就是一次重新挂载(`refetchOnMount` 默认开着),当场就是新的。
 */
export const RENDER_SOURCE_KEY = ["cards", "render-source"] as const;

export function useRenderSource() {
	return useQuery({
		queryKey: RENDER_SOURCE_KEY,
		queryFn: () => api.get<{ enabled: boolean }>("/api/cards/render-source"),
		staleTime: 30_000,
	});
}

/**
 * 草稿 → **一张真图**(`POST /api/cards/skin-shot`)。与实时预览同源(server 那头共用
 * 「清单 → HTML」那一步),差别只在这张是 server 上的 Chrome 画的。
 *
 * 同 `usePreviewCardSkin` 不进缓存:键就是整份清单,存下来只会把内存填满而命中率是零。
 */
export function useShotCardSkin() {
	return useMutation({
		mutationFn: (v: { skinId: string; kind: CardSkinKind; scene?: string; manifest: unknown }) =>
			api.post<CardSkinShotResponse>("/api/cards/skin-shot", v),
	});
}

/**
 * 草稿 → 一整份 HTML(`POST /api/card-skins/:id/preview`)。
 *
 * **不进 react-query 缓存**:草稿每敲一个字都是新的,缓存键就是整份清单,存下来只会把
 * 内存填满而命中率是零。改成 mutation —— 「这一版草稿画一次」本来就是个动作。
 */
export function usePreviewCardSkin(id: string) {
	return useMutation({
		mutationFn: (v: { kind: CardSkinKind; scene?: string; manifest: unknown }) =>
			api.post<CardSkinPreviewResponse>(`/api/card-skins/${id}/preview`, v),
	});
}
