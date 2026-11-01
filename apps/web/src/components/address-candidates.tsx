import type { AddressCandidate, AddressCandidatesResponse } from "@bilibili-notify/contract";
import { Btn } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useT } from "../i18n";
import { api } from "../services/api";

/** 读这条连接上某一种可挑的地址(`GET /api/connections/:id/addresses`)。 */
function fetchAddressCandidates(
	connectionId: string,
	scope: "group" | "private" | "channel",
): Promise<AddressCandidate[]> {
	return api
		.get<AddressCandidatesResponse>(`/api/connections/${connectionId}/addresses?scope=${scope}`)
		.then((r) => r.candidates);
}

/** 一个频道服务器和它名下的文字子频道(候选按 `parentAddress` 分组还原出来的)。 */
interface GuildGroup {
	guildId: string;
	name: string;
	channels: AddressCandidate[];
}

/** 平的候选 → 按服务器分组,组与组内的顺序都保持候选原来的顺序。 */
function groupByGuild(candidates: readonly AddressCandidate[]): GuildGroup[] {
	const groups = new Map<string, GuildGroup>();
	for (const c of candidates) {
		const guildId = c.parentAddress ?? "";
		let group = groups.get(guildId);
		if (!group) {
			group = { guildId, name: c.parentName ?? guildId, channels: [] };
			groups.set(guildId, group);
		}
		group.channels.push(c);
	}
	return [...groups.values()];
}

/** 读取适配器提供的群 / 私聊地址候选，选择后原样回填。 */
export function SessionAddressPicker({
	connectionId,
	scope,
	onPick,
}: {
	connectionId: string;
	scope: "group" | "private";
	onPick: (address: string) => void;
}) {
	const tx = useT();
	const { data, isLoading, isError, refetch, isFetching } = useQuery({
		queryKey: ["address-candidates", connectionId, scope],
		queryFn: () => fetchAddressCandidates(connectionId, scope),
		enabled: Boolean(connectionId),
	});
	const list = data ?? [];
	const label =
		scope === "group"
			? tx("addressCandidates.sessionAddressPicker.text1")
			: tx("addressCandidates.sessionAddressPicker.text2");
	return (
		<CandidateBox
			title={tx("addressCandidates.sessionAddressPicker.text3", { value0: label })}
			actionLabel={tx("addressCandidates.sessionAddressPicker.text4")}
			pendingLabel={tx("addressCandidates.sessionAddressPicker.text5")}
			pending={isFetching}
			onAction={() => refetch()}
		>
			{isLoading ? (
				<div className="text-bn-xs text-bn-text-tertiary">
					{tx("addressCandidates.sessionAddressPicker.text6")}
				</div>
			) : isError ? (
				<div className="text-bn-xs text-bn-danger">
					{tx("addressCandidates.sessionAddressPicker.text7")}
				</div>
			) : list.length === 0 ? (
				<div className="text-bn-xs leading-relaxed text-bn-text-tertiary">
					{tx("addressCandidates.sessionAddressPicker.text8")}
				</div>
			) : (
				<div className="flex flex-col gap-1">
					{/* 候选行走 option —— 从列表里挑一个,不是执行动作,所以不吃按钮的皮。 */}
					{list.map((e) => (
						<button
							key={e.address}
							type="button"
							onClick={() => onPick(e.address)}
							data-bn="option"
							className="flex items-center gap-2 rounded-sm border border-bn-border bg-bn-surface px-2 py-1 text-left transition hover:border-bn-pink"
						>
							<span className="truncate text-bn-xs font-semibold text-bn-text-primary">
								{e.name ?? tx("addressCandidates.sessionAddressPicker.text9")}
							</span>
							<span className="truncate font-mono text-bn-2xs text-bn-text-tertiary">
								{e.address}
							</span>
						</button>
					))}
				</div>
			)}
		</CandidateBox>
	);
}

/**
 * 频道子频道选择器 —— 手动触发 `GET /api/connections/:id/addresses?scope=channel`(每次实时拉,
 * 避免每次打开弹窗都请求上游)。选择后同时回填父地址与地址。
 */
export function ChannelAddressPicker({
	connectionId,
	onPick,
}: {
	connectionId: string;
	onPick: (guildId: string, channelId: string) => void;
}) {
	const tx = useT();
	const { data, isError, refetch, isFetching, fetchStatus } = useQuery({
		queryKey: ["address-candidates", connectionId, "channel"],
		queryFn: () => fetchAddressCandidates(connectionId, "channel"),
		enabled: false, // 手动触发，不在打开弹窗时请求上游
	});
	const guilds = groupByGuild(data ?? []);
	const fetched = fetchStatus === "idle" && data !== undefined;
	return (
		<CandidateBox
			title={tx("addressCandidates.channelAddressPicker.text1")}
			actionLabel={tx("addressCandidates.channelAddressPicker.text2")}
			pendingLabel={tx("addressCandidates.channelAddressPicker.text3")}
			pending={isFetching}
			onAction={() => refetch()}
		>
			{isError ? (
				<div className="text-bn-xs text-bn-danger">
					{tx("addressCandidates.channelAddressPicker.text4")}
				</div>
			) : !fetched ? (
				<div className="text-bn-xs text-bn-text-tertiary">
					{tx("addressCandidates.channelAddressPicker.text5")}
				</div>
			) : guilds.length === 0 ? (
				<div className="text-bn-xs text-bn-text-tertiary">
					{tx("addressCandidates.channelAddressPicker.text6")}
				</div>
			) : (
				<div className="flex flex-col gap-1.5">
					{guilds.map((g) => (
						<div key={g.guildId}>
							<div className="truncate text-bn-xs font-semibold text-bn-text-secondary">
								{g.name}
							</div>
							<div className="mt-0.5 flex flex-wrap gap-1">
								{/* 候选 chip 走 option:挑频道,不是执行动作。 */}
								{g.channels.map((ch) => (
									<button
										key={ch.address}
										type="button"
										onClick={() => onPick(g.guildId, ch.address)}
										data-bn="option"
										className="rounded-sm border border-bn-border bg-bn-surface px-2 py-0.5 text-bn-xs text-bn-text-primary transition hover:border-bn-pink"
									>
										{ch.name}
									</button>
								))}
							</div>
						</div>
					))}
				</div>
			)}
		</CandidateBox>
	);
}

/**
 * 候选拉取盒 —— 虚线盒 + 「标题 + ghost 触发钮」头行。会话与频道两个选择器
 * 此前各抄一份,连 mb-1 的头行都逐字符相同;拉取状态与候选列表由调用方摆。
 */
function CandidateBox({
	title,
	actionLabel,
	pendingLabel,
	pending,
	onAction,
	children,
}: {
	title: string;
	actionLabel: string;
	pendingLabel: string;
	pending: boolean;
	onAction: () => void;
	children: ReactNode;
}) {
	return (
		<div className="mt-1.5 rounded-md border border-dashed border-bn-border px-2.5 py-2">
			<div className="mb-1 flex items-center justify-between">
				<span className="text-bn-xs font-bold text-bn-text-secondary">{title}</span>
				<Btn variant="ghost" size="sm" onClick={onAction} disabled={pending}>
					{pending ? pendingLabel : actionLabel}
				</Btn>
			</div>
			{children}
		</div>
	);
}
