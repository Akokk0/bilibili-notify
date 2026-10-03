/**
 * `/api/subscriptions/tags` —— 订阅标签表(ADR-0034)。
 *
 * 订阅只记标签的 id,名字与顺序都住在这张表里:订阅页的筛选胶囊、卡片角标、挑标签的弹框、订阅详情的
 * 「标签」一行都读它,共用 `["subscription-tags"]` 这个 key **是承重的** —— 在弹框里就地新建一个标签后,
 * 别处要当场看见它;`useStateChannel` 也按这个 key 失效(别的标签页改了表、重连补错过的变化)。
 * 各起各的 key 的话页面照样画得出来,只是再也不跟着刷新,而且没有任何报错。
 *
 * 写只有一个口:`PUT` 整张表(新建 / 改名 / 排序 / 删除都走它,新标签的 id 由面板生成)。
 */

import type { SubscriptionTag } from "@bilibili-notify/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../services/api";

export const SUBSCRIPTION_TAGS_QUERY_KEY = ["subscription-tags"] as const;

const SUBSCRIPTION_TAGS_PATH = "/api/subscriptions/tags";

/** 整张标签表,顺序就是表里的顺序(也是订阅页筛选胶囊的顺序)。 */
export function useSubscriptionTags() {
	return useQuery({
		queryKey: SUBSCRIPTION_TAGS_QUERY_KEY,
		queryFn: () => api.get<SubscriptionTag[]>(SUBSCRIPTION_TAGS_PATH),
	});
}

/**
 * 整张表换上去。服务端回存下的那张表(名字已去首尾空白),直接写进缓存 —— 弹框里刚建的标签当场就能
 * 在别处显示,不必再等一轮重取。被拒(重名 / 空名)时抛 `ApiError`,表原样不动。
 */
export function useReplaceSubscriptionTags() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (table: SubscriptionTag[]) =>
			api.put<SubscriptionTag[]>(SUBSCRIPTION_TAGS_PATH, table),
		onSuccess: (saved) => qc.setQueryData(SUBSCRIPTION_TAGS_QUERY_KEY, saved),
	});
}
