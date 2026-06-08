import { useMemo, useState } from "react";
import { dashboardApi } from "../api/client";
import type {
	DashboardBootstrap,
	FeatureKey,
	Subscription,
	UserLookupResult,
	UserSearchResult,
} from "../api/types";
import { FEATURE_KEYS, FEATURE_LABELS } from "../api/types";
import {
	Badge,
	Button,
	Card,
	ConfirmButton,
	EmptyState,
	ErrorBanner,
	Field,
	Input,
	TextArea,
} from "../components/ui";
import { featureRouteSummary, subscriptionTitle, withRouteTarget } from "../lib/config";

interface SubscriptionsTabProps {
	readonly data: DashboardBootstrap;
	readonly onData: (data: DashboardBootstrap) => void;
	readonly onReload: () => Promise<void>;
}

export function SubscriptionsTab({ data, onData, onReload }: SubscriptionsTabProps) {
	const [uid, setUid] = useState("");
	const [query, setQuery] = useState("");
	const [lookup, setLookup] = useState<UserLookupResult | null>(null);
	const [search, setSearch] = useState<UserSearchResult | null>(null);
	const [groupFilter, setGroupFilter] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);

	const groups = useMemo(() => {
		const set = new Set<string>();
		for (const sub of data.subscriptions) for (const group of sub.groups) set.add(group);
		return [...set].sort((a, b) => a.localeCompare(b));
	}, [data.subscriptions]);
	const subscriptions = groupFilter
		? data.subscriptions.filter((sub) => sub.groups.includes(groupFilter))
		: data.subscriptions;

	const run = async (fn: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await fn();
		} catch (err) {
			setError(err);
		} finally {
			setBusy(false);
		}
	};

	const lookupUid = () =>
		run(async () => {
			setLookup(await dashboardApi.lookupUser(uid.trim()));
		});

	const searchUsers = () =>
		run(async () => {
			setSearch(await dashboardApi.searchUsers(query.trim(), 1));
		});

	const addUser = (user: UserLookupResult) =>
		run(async () => {
			const subscriptions = await dashboardApi.createSubscription({
				uid: user.uid,
				name: user.name,
				enabled: true,
			});
			onData({ ...data, subscriptions });
			await onReload();
		});

	const patchSub = (id: string, patch: Record<string, unknown>) =>
		run(async () => {
			const nextSub = await dashboardApi.patchSubscription(id, patch);
			onData({
				...data,
				subscriptions: data.subscriptions.map((sub) => (sub.id === nextSub.id ? nextSub : sub)),
			});
		});

	const deleteSub = (sub: Subscription) =>
		run(async () => {
			await dashboardApi.deleteSubscription(sub.id);
			onData({ ...data, subscriptions: data.subscriptions.filter((item) => item.id !== sub.id) });
		});

	return (
		<div className="grid gap-5">
			<ErrorBanner error={error} />
			<div className="grid gap-5 lg:grid-cols-2">
				<Card title="UID lookup" description="输入数字 UID，读取 B 站公开资料后添加订阅。">
					<div className="flex gap-2">
						<Input
							value={uid}
							onChange={(event) => setUid(event.target.value)}
							placeholder="例如 123456"
							inputMode="numeric"
						/>
						<Button tone="primary" disabled={!uid.trim() || busy} onClick={lookupUid}>
							查询
						</Button>
					</div>
					{lookup ? (
						<UserCandidate user={lookup} onAdd={() => addUser(lookup)} busy={busy} />
					) : null}
				</Card>
				<Card
					title="昵称搜索"
					description="未登录或 B 站接口不可用时会显示脱敏错误。不会自动订阅第一个结果。"
				>
					<div className="flex gap-2">
						<Input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="输入 UP 昵称关键词"
						/>
						<Button tone="primary" disabled={!query.trim() || busy} onClick={searchUsers}>
							搜索
						</Button>
					</div>
					{search ? (
						<div className="mt-4 grid gap-3">
							<div className="text-bn-text-secondary text-sm">
								共 {search.total} 个结果，当前第 {search.page} 页。
							</div>
							{search.results.map((user) => (
								<UserCandidate key={user.uid} user={user} onAdd={() => addUser(user)} busy={busy} />
							))}
						</div>
					) : null}
				</Card>
			</div>

			<Card
				title="订阅列表"
				description="管理 enable/delete、分组筛选和各特性到 AstrBot 目标的路由。"
				action={
					groups.length > 0 ? (
						<select
							className="rounded-xl border border-black/10 bg-white/80 px-3 py-2 text-sm"
							value={groupFilter}
							onChange={(event) => setGroupFilter(event.target.value)}
						>
							<option value="">全部分组</option>
							{groups.map((group) => (
								<option key={group} value={group}>
									{group}
								</option>
							))}
						</select>
					) : null
				}
			>
				{subscriptions.length === 0 ? (
					<EmptyState>还没有订阅。先通过 UID lookup 或昵称搜索添加一个 UP。</EmptyState>
				) : null}
				<div className="grid gap-4">
					{subscriptions.map((sub) => (
						<SubscriptionCard
							key={sub.id}
							sub={sub}
							targets={data.targets}
							busy={busy}
							onPatch={(patch) => patchSub(sub.id, patch)}
							onDelete={() => deleteSub(sub)}
						/>
					))}
				</div>
			</Card>
		</div>
	);
}

function UserCandidate({
	user,
	onAdd,
	busy,
}: {
	readonly user: UserLookupResult;
	readonly onAdd: () => void;
	readonly busy: boolean;
}) {
	return (
		<div className="mt-4 flex items-center gap-3 rounded-2xl bg-white/65 p-3 ring-1 ring-black/5">
			{user.avatar ? (
				<img src={user.avatar} alt="" className="h-12 w-12 rounded-full object-cover" />
			) : (
				<div className="h-12 w-12 rounded-full bg-bn-blue-soft" />
			)}
			<div className="min-w-0 flex-1">
				<div className="truncate font-semibold">{user.name || user.uid}</div>
				<div className="text-bn-text-secondary text-xs">
					UID {user.uid} · 粉丝 {user.fans.toLocaleString()}
				</div>
				{user.sign ? (
					<div className="mt-1 line-clamp-2 text-bn-text-tertiary text-xs">{user.sign}</div>
				) : null}
			</div>
			<Button tone="primary" onClick={onAdd} disabled={busy}>
				添加
			</Button>
		</div>
	);
}

function SubscriptionCard({
	sub,
	targets,
	busy,
	onPatch,
	onDelete,
}: {
	readonly sub: Subscription;
	readonly targets: DashboardBootstrap["targets"];
	readonly busy: boolean;
	readonly onPatch: (patch: Record<string, unknown>) => void;
	readonly onDelete: () => void;
}) {
	const [name, setName] = useState(sub.name ?? "");
	const [groups, setGroups] = useState(sub.groups.join(", "));
	const [notes, setNotes] = useState(sub.notes ?? "");
	const [editingMeta, setEditingMeta] = useState(false);

	const saveMeta = () => {
		onPatch({
			name: name.trim() || undefined,
			groups: groups
				.split(/,|\n/)
				.map((item) => item.trim())
				.filter(Boolean),
			notes: notes.trim() || undefined,
		});
		setEditingMeta(false);
	};

	const toggleRoute = (feature: FeatureKey, targetId: string, enabled: boolean) => {
		onPatch({ routing: withRouteTarget(sub.routing, feature, targetId, enabled) });
	};

	return (
		<article className="rounded-3xl bg-white/65 p-4 ring-1 ring-black/5">
			<header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
				<div>
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="font-semibold text-lg">{subscriptionTitle(sub)}</h3>
						<Badge tone={sub.enabled ? "success" : "neutral"}>
							{sub.enabled ? "启用" : "停用"}
						</Badge>
						{sub.groups.map((group) => (
							<Badge key={group} tone="info">
								{group}
							</Badge>
						))}
					</div>
					<p className="mt-1 text-bn-text-secondary text-sm">
						{featureRouteSummary(sub.routing, FEATURE_LABELS, targets)}
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button onClick={() => onPatch({ enabled: !sub.enabled })} disabled={busy}>
						{sub.enabled ? "停用" : "启用"}
					</Button>
					<Button onClick={() => setEditingMeta((value) => !value)}>
						{editingMeta ? "收起编辑" : "编辑信息"}
					</Button>
					<ConfirmButton
						tone="danger"
						confirmText={`确定删除订阅 ${subscriptionTitle(sub)}？`}
						onConfirm={onDelete}
						disabled={busy}
					>
						删除
					</ConfirmButton>
				</div>
			</header>

			{editingMeta ? (
				<div className="mt-4 grid gap-3 md:grid-cols-3">
					<Field label="显示名 / 别名">
						<Input value={name} onChange={(event) => setName(event.target.value)} />
					</Field>
					<Field label="分组" hint="逗号或换行分隔">
						<Input value={groups} onChange={(event) => setGroups(event.target.value)} />
					</Field>
					<Field label="备注">
						<TextArea value={notes} onChange={(event) => setNotes(event.target.value)} />
					</Field>
					<div className="md:col-span-3">
						<Button tone="primary" onClick={saveMeta}>
							保存订阅信息
						</Button>
					</div>
				</div>
			) : null}

			<div className="mt-4">
				<div className="mb-2 font-medium text-bn-text-tertiary text-sm">路由</div>
				{targets.length === 0 ? (
					<EmptyState>还没有推送目标。请先到「推送目标」Tab 生成配对码并绑定会话。</EmptyState>
				) : null}
				{targets.length > 0 ? (
					<div className="overflow-x-auto rounded-2xl bg-white/60 p-3 bn-scrollbar">
						<table className="w-full min-w-[720px] text-left text-sm">
							<thead className="text-bn-text-secondary">
								<tr>
									<th className="p-2">特性</th>
									{targets.map((target) => (
										<th key={target.id} className="p-2">
											{target.name}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{FEATURE_KEYS.map((feature) => (
									<tr key={feature} className="border-black/5 border-t">
										<td className="p-2 font-medium">{FEATURE_LABELS[feature]}</td>
										{targets.map((target) => (
											<td key={target.id} className="p-2">
												<input
													type="checkbox"
													checked={sub.routing[feature].includes(target.id)}
													disabled={busy || !target.enabled}
													onChange={(event) =>
														toggleRoute(feature, target.id, event.target.checked)
													}
													className="h-4 w-4 accent-bn-pink"
												/>
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : null}
			</div>
		</article>
	);
}
