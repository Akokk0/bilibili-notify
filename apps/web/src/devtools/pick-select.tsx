/**
 * `sub` / `target` / `connection` / `creator` 四种参数的选择器:从站内既有列表里挑一个。
 * 第一项恒为「服务端默认」(空串,交上去时被剥掉,服务端按自己的默认值补 —— 直播类是第一个
 * 直播间连着的)。
 *
 * - `sub` / `target` / `connection` 只出现在核心的场景里,值是 id;订阅不分来源全列。停用的照列、标「停用」:
 *   造事件时偏要挑一个停用的看看是常事。
 * - `creator` 是交场景那个来源(`provider`)名单里的人,值是 externalId:名单只有启用的、同一个人只算一次,
 *   所以这里也只列那个来源启用的订阅、按人去重(ADR-0031 决策 2)。
 */

import type { SubscriptionDTO } from "@bilibili-notify/contract";
import type { Connection, PushTarget } from "@bilibili-notify/internal";
import { TSelect, type TSelectOption } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { targetDisplay } from "../components/target-display";
import { api } from "../services/api";
import { subscriptionIdentityOf } from "../types/domain";

export type PickKind = "sub" | "target" | "connection" | "creator";

type Option = TSelectOption;

const DEFAULT_OPTION: Option = { value: "", label: "（服务端默认）" };

function disabledTag(enabled: boolean): string {
	return enabled ? "" : "（停用）";
}

/** 订阅给人看的那一行:名字 · 外部 id。 */
function subLabel(sub: SubscriptionDTO): string {
	const { externalId } = subscriptionIdentityOf(sub);
	return `${sub.cachedProfile?.name ?? externalId} · ${externalId}`;
}

/** 与站内各页共用同一套查询键,列表已经在缓存里就不再打请求。 */
function useOptions(kind: PickKind, provider: string | undefined): Option[] {
	const subs = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<SubscriptionDTO[]>("/api/subscriptions"),
		enabled: kind === "sub" || kind === "creator",
	});
	const targets = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
		enabled: kind === "target",
	});
	const connections = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
		enabled: kind === "connection" || kind === "target",
	});
	switch (kind) {
		case "sub":
			return (subs.data ?? []).map((s) => ({
				value: s.id,
				label: `${subLabel(s)}${disabledTag(s.enabled)}`,
			}));
		case "creator": {
			const seen = new Set<string>();
			return (subs.data ?? []).flatMap((s) => {
				const { sourceKey, externalId } = subscriptionIdentityOf(s);
				if (sourceKey !== provider || !s.enabled || seen.has(externalId)) return [];
				seen.add(externalId);
				return [{ value: externalId, label: subLabel(s) }];
			});
		}
		case "target":
			return (targets.data ?? []).map((t) => {
				const display = targetDisplay(t, connections.data ?? []);
				return { ...display, label: `${display.label}${disabledTag(t.enabled)}` };
			});
		case "connection":
			return (connections.data ?? []).map((a) => ({
				value: a.id,
				label: `${a.name}${disabledTag(a.enabled)}`,
			}));
	}
}

export function PickSelect({
	kind,
	provider,
	label,
	value,
	onChange,
}: {
	kind: PickKind;
	/** 交这个场景的那一家(描述符的 `provider`);`creator` 按它挑来源。 */
	provider?: string;
	label: string;
	value: string;
	onChange: (v: string) => void;
}) {
	const options = useOptions(kind, provider);
	return (
		<TSelect
			ariaLabel={label}
			value={value}
			options={[DEFAULT_OPTION, ...options]}
			onChange={onChange}
		/>
	);
}
