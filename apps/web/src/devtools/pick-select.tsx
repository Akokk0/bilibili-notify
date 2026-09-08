/**
 * `sub` / `target` / `adapter` 三种参数的选择器:从站内既有列表里挑一个,值是它的 id。
 * 第一项恒为「服务端默认」(空串,交上去时被剥掉,服务端按自己的默认值补 —— `sub` 是第一个
 * 启用且直播间连着的订阅)。停用的照列、标「停用」:造事件时偏要挑一个停用的看看是常事。
 */

import type { SubscriptionDTO } from "@bilibili-notify/contract";
import type { Connection, PushTarget } from "@bilibili-notify/internal";
import { TSelect } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { api } from "../services/api";

export type PickKind = "sub" | "target" | "adapter";

interface Option {
	value: string;
	label: string;
}

const DEFAULT_OPTION: Option = { value: "", label: "（服务端默认）" };

function disabledTag(enabled: boolean): string {
	return enabled ? "" : "（停用）";
}

/** 与站内各页共用同一套查询键,列表已经在缓存里就不再打请求。 */
function useOptions(kind: PickKind): Option[] {
	const subs = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<SubscriptionDTO[]>("/api/subs"),
		enabled: kind === "sub",
	});
	const targets = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
		enabled: kind === "target",
	});
	const connections = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
		enabled: kind === "adapter",
	});
	switch (kind) {
		case "sub":
			return (subs.data ?? []).map((s) => ({
				value: s.id,
				label: `${s.name ?? s.cachedProfile?.name ?? s.uid} · ${s.uid}${disabledTag(s.enabled)}`,
			}));
		case "target":
			return (targets.data ?? []).map((t) => ({
				value: t.id,
				label: `${t.name}${disabledTag(t.enabled)}`,
			}));
		case "adapter":
			return (connections.data ?? []).map((a) => ({
				value: a.id,
				label: `${a.name}${disabledTag(a.enabled)}`,
			}));
	}
}

export function PickSelect({
	kind,
	label,
	value,
	onChange,
}: {
	kind: PickKind;
	label: string;
	value: string;
	onChange: (v: string) => void;
}) {
	const options = useOptions(kind);
	return (
		<TSelect
			ariaLabel={label}
			value={value}
			options={[DEFAULT_OPTION, ...options]}
			onChange={onChange}
		/>
	);
}
