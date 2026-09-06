/**
 * 截流组的那张列表:闸开着时拦下的每一条推送(目标 / 适配器 / 文本摘要 / 图数)。
 *
 * 历史那边照记 delivered 不打标 —— 这里才是「其实没发出去」的对照;「清掉截流期间的历史行」
 * 按截流的时间段把那些行删掉,免得测完一轮历史页里全是假的「已送达」。
 */

import type {
	DevCapturedDelivery,
	DevCapturesDTO,
	DevPurgeHistoryResponse,
} from "@bilibili-notify/contract";
import { Btn, EmptyNote, HintNote, Icon, Pill, PlatformIcon } from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../services/api";

export const CAPTURES_QUERY_KEY = ["dev", "captures"] as const;

/** 拦下的条目只在闸开着时增长;开着就每两秒看一眼,关着就不打扰。 */
function refetchInterval(data: DevCapturesDTO | undefined): number | false {
	return data?.enabled ? 2_000 : false;
}

export function CaptureView() {
	const qc = useQueryClient();
	const q = useQuery({
		queryKey: CAPTURES_QUERY_KEY,
		queryFn: () => api.get<DevCapturesDTO>("/api/dev/captures"),
		refetchInterval: (query) => refetchInterval(query.state.data),
		// 同 use-devtools 那条:人在别的窗口看推送有没有真出网时,这张列表得自己长。
		refetchIntervalInBackground: true,
	});
	const clear = useMutation({
		mutationFn: () => api.post<DevCapturesDTO>("/api/dev/captures/clear", {}),
		onSuccess: (data) => qc.setQueryData(CAPTURES_QUERY_KEY, data),
	});
	const [purged, setPurged] = useState<number | null>(null);
	const purge = useMutation({
		mutationFn: () => api.post<DevPurgeHistoryResponse>("/api/dev/captures/purge-history", {}),
		onSuccess: (res) => setPurged(res.deleted),
		// 历史页、概览的时间轴与趋势图都从历史读 —— 删完让它们重新拉。
		onSettled: () => void qc.invalidateQueries(),
	});

	const data = q.data;
	if (!data) return null;
	const empty = data.entries.length === 0;

	return (
		<section className="mt-4">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-bn-sm font-bold text-bn-text-primary">拦下的推送</span>
				<Pill
					subtle
					size="sm"
					color={data.enabled ? "var(--color-bn-pink)" : "var(--color-bn-inactive)"}
				>
					{data.enabled ? `截流中 · ${data.entries.length} 条` : "关着"}
				</Pill>
				<span className="flex-1" />
				<Btn
					variant="outline"
					size="sm"
					disabled={empty || clear.isPending}
					onClick={() => clear.mutate()}
				>
					清空列表
				</Btn>
				<Btn
					variant="danger-outline"
					size="sm"
					disabled={purge.isPending}
					onClick={() => purge.mutate()}
				>
					清掉截流期间的历史行
				</Btn>
			</div>
			{purged !== null ? (
				<HintNote tone="success" className="mt-2">
					清掉了 {purged} 行。历史页与概览已重新拉取。
				</HintNote>
			) : null}
			{purge.error ? (
				<HintNote tone="danger" className="mt-2">
					没清成:{purge.error instanceof Error ? purge.error.message : String(purge.error)}
				</HintNote>
			) : null}
			{empty ? (
				<EmptyNote size="sm" className="mt-3">
					{data.enabled
						? "截流开着,还没拦到东西 —— 去「事件」组造一条,或者等真的推送来。"
						: "截流关着。上面那张「推送截流」卡按「跑一下」就开始拦。"}
				</EmptyNote>
			) : (
				<ul className="mt-3 flex flex-col gap-1.5">
					{[...data.entries].reverse().map((e) => (
						<CaptureRow key={e.id} entry={e} />
					))}
				</ul>
			)}
		</section>
	);
}

function timeOf(ms: number): string {
	return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

function CaptureRow({ entry }: { entry: DevCapturedDelivery }) {
	return (
		<li className="flex items-start gap-3 rounded-bn-sm border border-bn-border bg-bn-surface/70 px-3 py-2">
			<span className="w-16 shrink-0 pt-0.5 font-mono text-bn-2xs text-bn-text-tertiary">
				{timeOf(entry.at)}
			</span>
			<span className="flex w-44 shrink-0 flex-col gap-0.5">
				<span className="flex items-center gap-1.5 text-bn-sm font-bold text-bn-text-primary">
					<PlatformIcon platform={entry.platform} size={14} />
					<span className="truncate">{entry.targetName}</span>
					{entry.private ? (
						<Pill subtle size="sm">
							私聊
						</Pill>
					) : null}
				</span>
				<span className="truncate text-bn-2xs text-bn-text-tertiary">{entry.adapterName}</span>
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-1.5">
					<Pill subtle size="sm" color="var(--color-bn-blue)">
						{entry.kind}
					</Pill>
					{entry.images > 0 ? (
						<span
							role="img"
							aria-label={`${entry.images} 张图`}
							title={`${entry.images} 张图`}
							className="flex items-center gap-0.5 text-bn-2xs text-bn-text-tertiary"
						>
							<Icon.image size={12} />
							{entry.images}
						</span>
					) : null}
				</span>
				{entry.text ? (
					<p className="mt-1 line-clamp-2 whitespace-pre-line text-bn-xs leading-relaxed text-bn-text-secondary">
						{entry.text}
					</p>
				) : null}
			</span>
		</li>
	);
}
