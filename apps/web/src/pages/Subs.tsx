import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Btn, Input } from "../components/atoms";
import { ModalShell } from "../components/dialog";
import { Icon } from "../components/icons";
import { ApiError, api } from "../services/api";
import { makeEmptySubscription, type PushTarget, type Subscription } from "../types/domain";
import { displayName } from "./up/helpers";
import { UpCard } from "./up/UpCard";
import { UpDialog } from "./up/UpDialog";

type FilterId = "all" | "enabled" | "disabled";

interface FilterDef {
	id: FilterId;
	label: string;
	matches: (s: Subscription) => boolean;
}

const FILTERS: ReadonlyArray<FilterDef> = [
	{ id: "all", label: "全部", matches: () => true },
	{ id: "enabled", label: "已启用", matches: (s) => s.enabled },
	{ id: "disabled", label: "已禁用", matches: (s) => !s.enabled },
];

/** Sentinel for "show subscriptions with no groups assigned". */
const UNGROUPED = "__ungrouped__";

interface UpProfileLookup {
	uid: string;
	name: string;
	avatar: string;
	sign: string;
	fans: number;
}

function GroupChip({
	label,
	count,
	active,
	onClick,
	muted,
}: {
	label: string;
	count: number;
	active: boolean;
	onClick: () => void;
	muted?: boolean;
}) {
	const base =
		"inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition";
	const cls = active
		? "border border-bn-pink bg-bn-pink/10 text-bn-pink"
		: muted
			? "border border-dashed border-bn-border bg-bn-surface/60 text-bn-text-tertiary hover:text-bn-text-primary"
			: "border border-bn-border bg-bn-surface text-bn-text-secondary hover:border-bn-pink/60 hover:text-bn-text-primary";
	return (
		<button type="button" onClick={onClick} className={`${base} ${cls}`}>
			<span className="max-w-[140px] truncate">{label}</span>
			<span className="font-mono text-[10.5px] opacity-70">{count}</span>
		</button>
	);
}

interface SearchResponse {
	results: UpProfileLookup[];
	page: number;
	pageSize: number;
	total: number;
}

/**
 * "添加 UP" 弹窗。输入纯数字时走 `/api/subs/lookup` 单条 preview(原 UID 流程);
 * 输入非数字时走 `/api/subs/search` 列出 5 条结果,翻页 + 整行点击直接提交订阅。
 * 已订阅的行不可点击并附「已订阅」灰显标识。
 */
function NewSubDialog({
	onSubmit,
	onCancel,
	pending,
	error,
	existingUids,
}: {
	onSubmit: (profile: UpProfileLookup) => void;
	onCancel: () => void;
	pending: boolean;
	error: string | null;
	existingUids: Set<string>;
}) {
	const [input, setInput] = useState("");
	const [profile, setProfile] = useState<UpProfileLookup | null>(null);
	const [searchData, setSearchData] = useState<SearchResponse | null>(null);
	const [searchTerm, setSearchTerm] = useState("");
	const [page, setPage] = useState(1);
	const [opErr, setOpErr] = useState<string | null>(null);

	const trimmed = input.trim();
	const mode: "uid" | "name" = /^\d+$/.test(trimmed) ? "uid" : "name";
	const duplicate = mode === "uid" && trimmed.length > 0 && existingUids.has(trimmed);

	const lookup = useMutation({
		mutationFn: (q: string) =>
			api.get<UpProfileLookup>(`/api/subs/lookup?uid=${encodeURIComponent(q)}`),
		onSuccess: (data) => {
			setProfile(data);
			setSearchData(null);
			setOpErr(null);
		},
		onError: (err) => {
			setProfile(null);
			setSearchData(null);
			setOpErr(formatApiError(err, "lookup"));
		},
	});

	const search = useMutation({
		mutationFn: ({ q, p }: { q: string; p: number }) =>
			api.get<SearchResponse>(`/api/subs/search?q=${encodeURIComponent(q)}&page=${p}`),
		onSuccess: (data) => {
			setSearchData(data);
			setProfile(null);
			setOpErr(null);
		},
		onError: (err) => {
			setSearchData(null);
			setProfile(null);
			setOpErr(formatApiError(err, "search"));
		},
	});

	function reset(): void {
		setProfile(null);
		setSearchData(null);
		setSearchTerm("");
		setPage(1);
		setOpErr(null);
		lookup.reset();
		search.reset();
	}

	function handleInputChange(next: string): void {
		setInput(next);
		if (profile || searchData || opErr) reset();
	}

	function runQuery(): void {
		if (!trimmed) return;
		if (mode === "uid") {
			lookup.mutate(trimmed);
		} else {
			setSearchTerm(trimmed);
			setPage(1);
			search.mutate({ q: trimmed, p: 1 });
		}
	}

	function gotoPage(p: number): void {
		if (!searchTerm || p < 1) return;
		setPage(p);
		search.mutate({ q: searchTerm, p });
	}

	const busy = lookup.isPending || search.isPending || pending;
	const queryDisabled = !trimmed || busy;
	const queryLabel = mode === "uid" ? "查询" : "搜索";
	const totalPages = searchData
		? Math.max(1, Math.ceil(searchData.total / Math.max(1, searchData.pageSize)))
		: 1;

	return (
		<ModalShell onCancel={onCancel} width={420} bodyClassName="p-5">
			<div className="mb-1 text-base font-bold text-bn-text-primary">添加 UP 主</div>
			<div className="mb-4 text-[12px] text-bn-text-secondary">
				输入纯数字走 UID 精确查询; 输入名字走搜索,选定后进入配置表单
			</div>
			<div className="flex gap-2">
				<Input
					full
					value={input}
					onChange={handleInputChange}
					placeholder="搜索 UID 或 UP 主名字"
					icon={<Icon.user size={14} />}
				/>
				<Btn variant="outline" size="sm" onClick={runQuery} disabled={queryDisabled}>
					{busy ? `${queryLabel}中…` : queryLabel}
				</Btn>
			</div>
			{duplicate ? (
				<div className="mt-3 rounded border border-bn-warning-border bg-bn-warning-soft p-2 text-xs text-bn-warning-text">
					该 UID 已经在订阅列表中,无需重复添加
				</div>
			) : null}
			{opErr ? (
				<div className="mt-3 rounded border border-bn-danger-border bg-bn-danger-soft p-2 text-xs text-bn-danger-text">
					{opErr}
				</div>
			) : null}
			{profile ? (
				<ProfilePreview profile={profile} subscribed={existingUids.has(profile.uid)} />
			) : null}
			{searchData ? (
				<SearchResultList
					data={searchData}
					page={page}
					totalPages={totalPages}
					existingUids={existingUids}
					pending={pending}
					onPick={onSubmit}
					onPrev={() => gotoPage(page - 1)}
					onNext={() => gotoPage(page + 1)}
				/>
			) : null}
			{error ? (
				<div className="mt-3 rounded border border-bn-danger-border bg-bn-danger-soft p-2 text-xs text-bn-danger-text">
					{error}
				</div>
			) : null}
			<div className="mt-4 flex justify-end gap-2">
				<Btn variant="outline" size="sm" onClick={onCancel} disabled={pending}>
					{searchData ? "关闭" : "取消"}
				</Btn>
				{profile ? (
					<Btn
						variant="primary"
						size="sm"
						onClick={() => onSubmit(profile)}
						disabled={existingUids.has(profile.uid) || pending}
					>
						下一步
					</Btn>
				) : null}
			</div>
		</ModalShell>
	);
}

function ProfilePreview({
	profile,
	subscribed,
}: {
	profile: UpProfileLookup;
	subscribed: boolean;
}) {
	return (
		<div className="mt-4 flex items-center gap-3 rounded-lg border border-bn-border bg-bn-surface-muted p-3">
			<img
				src={profile.avatar}
				alt={profile.name}
				className="h-12 w-12 shrink-0 rounded-full bg-bn-surface object-cover"
				referrerPolicy="no-referrer"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-[13px] font-bold text-bn-text-primary">
						{profile.name}
					</span>
					<span className="font-mono text-[10.5px] text-bn-text-tertiary">UID {profile.uid}</span>
					{subscribed ? (
						<span className="rounded bg-bn-surface-muted px-1.5 py-0.5 text-[10px] font-semibold text-bn-text-tertiary">
							已订阅
						</span>
					) : null}
				</div>
				<div className="mt-0.5 text-[11px] text-bn-text-secondary">{fansLabel(profile.fans)}</div>
				{profile.sign ? (
					<div className="mt-1 line-clamp-2 text-[11px] text-bn-text-tertiary" title={profile.sign}>
						{profile.sign}
					</div>
				) : null}
			</div>
		</div>
	);
}

function SearchResultList({
	data,
	page,
	totalPages,
	existingUids,
	pending,
	onPick,
	onPrev,
	onNext,
}: {
	data: SearchResponse;
	page: number;
	totalPages: number;
	existingUids: Set<string>;
	pending: boolean;
	onPick: (profile: UpProfileLookup) => void;
	onPrev: () => void;
	onNext: () => void;
}) {
	return (
		<div className="mt-4 flex flex-col gap-1.5">
			{data.results.length === 0 ? (
				<div className="rounded border border-bn-border bg-bn-surface-muted p-4 text-center text-[12px] text-bn-text-tertiary">
					没有匹配的 UP 主
				</div>
			) : (
				data.results.map((r) => {
					const subscribed = existingUids.has(r.uid);
					const disabled = subscribed || pending;
					return (
						<button
							key={r.uid}
							type="button"
							onClick={() => !disabled && onPick(r)}
							disabled={disabled}
							className={`flex items-center gap-3 rounded-lg border p-2.5 text-left transition ${
								subscribed
									? "cursor-not-allowed border-bn-border bg-bn-surface-muted opacity-60"
									: "border-bn-border bg-bn-surface hover:border-bn-pink/60 hover:bg-bn-pink/5"
							}`}
						>
							<img
								src={r.avatar}
								alt={r.name}
								className="h-10 w-10 shrink-0 rounded-full bg-bn-surface object-cover"
								referrerPolicy="no-referrer"
							/>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-1.5">
									<span className="truncate text-[12.5px] font-bold text-bn-text-primary">
										{r.name}
									</span>
									<span className="font-mono text-[10.5px] text-bn-text-tertiary">UID {r.uid}</span>
									{subscribed ? (
										<span className="rounded bg-bn-surface-muted px-1.5 py-0.5 text-[10px] font-semibold text-bn-text-tertiary">
											已订阅
										</span>
									) : null}
								</div>
								<div className="mt-0.5 text-[10.5px] text-bn-text-secondary">
									{fansLabel(r.fans)}
									{r.sign ? (
										<span className="ml-2 text-bn-text-tertiary" title={r.sign}>
											· {truncate(r.sign, 30)}
										</span>
									) : null}
								</div>
							</div>
						</button>
					);
				})
			)}
			<div className="mt-1 flex items-center justify-between text-[11px] text-bn-text-tertiary">
				<span>
					第 {data.page} 页 / 共 {totalPages} 页 · 总 {data.total} 条
				</span>
				<div className="flex gap-1.5">
					<Btn variant="outline" size="sm" onClick={onPrev} disabled={page <= 1 || pending}>
						← 上一页
					</Btn>
					<Btn
						variant="outline"
						size="sm"
						onClick={onNext}
						disabled={page >= totalPages || pending}
					>
						下一页 →
					</Btn>
				</div>
			</div>
		</div>
	);
}

function fansLabel(n: number): string {
	if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万 粉丝`;
	return `${n} 粉丝`;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

function formatApiError(err: unknown, kind: "lookup" | "search"): string {
	if (err instanceof ApiError) {
		if (err.status === 404) return "未找到该 UP 主,请检查 UID 是否正确";
		if (err.status === 503) return "B 站 API 尚未就绪,请等待登录完成或稍后再试";
		if (err.status === 502) return `无法访问 B 站: ${err.message}`;
		if (err.status === 400 && kind === "search") return "搜索关键词不能为空";
		return err.message;
	}
	return err instanceof Error ? err.message : String(err);
}

export default function Subs() {
	const qc = useQueryClient();
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const subs = subsQuery.data ?? [];
	const targets = targetsQuery.data ?? [];

	const [q, setQ] = useState("");
	const [filterId, setFilterId] = useState<FilterId>("all");
	const [groupFilter, setGroupFilter] = useState<string | null>(null);
	const [selection, setSelection] = useState<Set<string>>(new Set());
	const [drawerSubId, setDrawerSubId] = useState<string | null>(null);
	const [showNewDialog, setShowNewDialog] = useState(false);
	/**
	 * Staged 草稿:点 NewSubDialog 搜索结果后,不立即 POST,而是构造一份 Subscription
	 * 草稿放这里,接着打开 UpDialog 让用户配 routing / features / template 等;点
	 * 「创建订阅」才落盘。关闭/取消则丢弃,UP 不会出现在订阅列表。
	 */
	const [newDraft, setNewDraft] = useState<Subscription | null>(null);
	const [error, setError] = useState<string | null>(null);

	const filterDef = FILTERS.find((f) => f.id === filterId) ?? FILTERS[0];

	// Group catalog derived from current subs. Counts each unique group name
	// across every subscription's groups[] (a sub can belong to multiple
	// groups), plus a synthetic "ungrouped" bucket for subs with no groups.
	const groupCounts = useMemo(() => {
		const counts = new Map<string, number>();
		let ungrouped = 0;
		for (const s of subs) {
			if (s.groups.length === 0) {
				ungrouped++;
			} else {
				for (const g of s.groups) counts.set(g, (counts.get(g) ?? 0) + 1);
			}
		}
		return { groups: counts, ungrouped };
	}, [subs]);
	const groupNames = useMemo(
		() => [...groupCounts.groups.keys()].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
		[groupCounts],
	);

	const filtered = useMemo(() => {
		const ql = q.trim().toLowerCase();
		return subs.filter((s) => {
			if (!filterDef.matches(s)) return false;
			if (groupFilter === UNGROUPED && s.groups.length > 0) return false;
			if (groupFilter && groupFilter !== UNGROUPED && !s.groups.includes(groupFilter)) return false;
			if (!ql) return true;
			return (
				s.uid.includes(ql) ||
				displayName(s).toLowerCase().includes(ql) ||
				(s.notes ?? "").toLowerCase().includes(ql)
			);
		});
	}, [subs, filterDef, q, groupFilter]);

	const filterCounts: Record<FilterId, number> = {
		all: subs.length,
		enabled: subs.filter((s) => s.enabled).length,
		disabled: subs.filter((s) => !s.enabled).length,
	};

	const drawerSub = drawerSubId ? (subs.find((s) => s.id === drawerSubId) ?? null) : null;

	const upsert = useMutation({
		mutationFn: async (s: Subscription) => {
			setError(null);
			try {
				await api.post<Subscription[]>("/api/subs", s);
				return s;
			} catch (err) {
				if (err instanceof ApiError) setError(err.message);
				else setError(String(err));
				throw err;
			}
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	const del = useMutation({
		mutationFn: async (id: string) => {
			await api.delete(`/api/subs/${id}`);
			return id;
		},
		onSuccess: (id) => {
			qc.invalidateQueries({ queryKey: ["subscriptions"] });
			setSelection((sel) => {
				const next = new Set(sel);
				next.delete(id);
				return next;
			});
			if (drawerSubId === id) setDrawerSubId(null);
		},
	});

	function toggleSelect(id: string): void {
		setSelection((sel) => {
			const next = new Set(sel);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	function toggleEnabled(s: Subscription, on: boolean): void {
		upsert.mutate({ ...s, enabled: on });
	}

	async function bulkSetEnabled(on: boolean): Promise<void> {
		const ids = [...selection];
		// 写前 refetch:从可能陈旧的 subs 快照构造 PUT,会用旧字段 last-writer-wins
		// 复活并发编辑的改动。先拉最新再据最新构造。
		await qc.refetchQueries({ queryKey: ["subscriptions"] });
		const fresh = qc.getQueryData<Subscription[]>(["subscriptions"]) ?? subs;
		const results = await Promise.allSettled(
			ids.map((id) => {
				const s = fresh.find((x) => x.id === id);
				if (!s) return Promise.resolve();
				return api.post<Subscription[]>("/api/subs", { ...s, enabled: on });
			}),
		);
		// allSettled 结果此前被丢弃 → 部分失败完全不可见。上报失败计数。
		const failed = results.filter((r) => r.status === "rejected").length;
		if (failed > 0) setError(`批量${on ? "启用" : "停用"}:${failed}/${ids.length} 个订阅操作失败`);
		qc.invalidateQueries({ queryKey: ["subscriptions"] });
	}

	function bulkDelete(): void {
		const ids = [...selection];
		void Promise.allSettled(ids.map((id) => api.delete(`/api/subs/${id}`))).then((results) => {
			qc.invalidateQueries({ queryKey: ["subscriptions"] });
			// P2:与 bulkSetEnabled 一致,上报失败计数(此前 allSettled 结果整个
			// 丢弃,部分删除失败完全不可见)。
			const failed = results.filter((r) => r.status === "rejected").length;
			if (failed > 0) setError(`批量删除:${failed}/${ids.length} 个订阅删除失败`);
			setSelection(new Set());
		});
	}

	function handleNew(profile: UpProfileLookup): void {
		// 不立即 upsert——构造草稿放进 newDraft,关 NewSubDialog,打开 UpDialog(create 模式)
		// 让用户先配 routing/features/template,点「创建订阅」才走 upsert.mutate 落盘。
		const fresh = makeEmptySubscription(profile.uid);
		fresh.cachedProfile = {
			name: profile.name,
			avatar: profile.avatar,
			sign: profile.sign,
			fans: profile.fans,
			lastRefreshedAt: new Date().toISOString(),
		};
		setNewDraft(fresh);
		setShowNewDialog(false);
	}

	return (
		<div className="bn-anim-fade-in space-y-4">
			<div className="flex flex-wrap items-center gap-2.5">
				<Input
					value={q}
					onChange={setQ}
					placeholder="搜索 UP 主名称或 UID..."
					icon={<Icon.search size={14} />}
				/>
				<div className="flex gap-1 rounded-md border border-bn-border-subtle bg-bn-surface/60 p-1 backdrop-blur-sm">
					{FILTERS.map((f) => {
						const active = filterId === f.id;
						return (
							<button
								type="button"
								key={f.id}
								onClick={() => setFilterId(f.id)}
								className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-semibold transition ${
									active
										? "bg-bn-surface text-bn-pink shadow-sm"
										: "text-bn-text-tertiary hover:text-bn-text-primary"
								}`}
							>
								{f.label}
								<span
									className={`text-[10px] font-bold ${
										active ? "text-bn-pink" : "text-bn-text-secondary"
									}`}
								>
									{filterCounts[f.id]}
								</span>
							</button>
						);
					})}
				</div>
				<div className="flex-1" />
				{selection.size > 0 ? (
					<div className="flex items-center gap-2 rounded-md bg-bn-pink/12 px-2.5 py-1 text-xs font-semibold text-bn-pink">
						已选 {selection.size} 项
						<Btn size="sm" variant="ghost" onClick={() => void bulkSetEnabled(true)}>
							批量启用
						</Btn>
						<Btn size="sm" variant="ghost" onClick={() => void bulkSetEnabled(false)}>
							批量禁用
						</Btn>
						<Btn size="sm" variant="danger" onClick={bulkDelete}>
							批量删除
						</Btn>
					</div>
				) : null}
				<Btn
					variant="primary"
					size="sm"
					icon={<Icon.plus size={12} />}
					onClick={() => setShowNewDialog(true)}
				>
					添加
				</Btn>
			</div>

			{groupNames.length > 0 || groupCounts.ungrouped > 0 ? (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-[11px] font-semibold text-bn-text-tertiary">分组</span>
					<GroupChip
						label="全部"
						count={subs.length}
						active={groupFilter === null}
						onClick={() => setGroupFilter(null)}
					/>
					{groupNames.map((g) => (
						<GroupChip
							key={g}
							label={g}
							count={groupCounts.groups.get(g) ?? 0}
							active={groupFilter === g}
							onClick={() => setGroupFilter(g)}
						/>
					))}
					{groupCounts.ungrouped > 0 ? (
						<GroupChip
							label="未分组"
							count={groupCounts.ungrouped}
							active={groupFilter === UNGROUPED}
							onClick={() => setGroupFilter(UNGROUPED)}
							muted
						/>
					) : null}
				</div>
			) : null}

			{error ? (
				<div className="rounded border border-bn-danger-border bg-bn-danger-soft p-2 text-xs text-bn-danger-text">
					{error}
				</div>
			) : null}

			{subsQuery.isLoading ? <div className="text-sm text-bn-text-secondary">加载中…</div> : null}
			{subsQuery.error ? (
				<div className="rounded border border-bn-danger-border bg-bn-danger-soft p-3 text-xs text-bn-danger-text">
					加载失败：{String((subsQuery.error as Error).message)}
				</div>
			) : null}
			{subsQuery.data &&
			filtered.length === 0 &&
			(q.trim() || filterId !== "all" || groupFilter) ? (
				<div className="rounded-bn-card border border-dashed border-bn-border bg-bn-surface/60 p-10 text-center">
					<div className="mb-1 text-sm font-bold text-bn-text-primary">没有匹配的订阅</div>
					<div className="text-[12px] text-bn-text-secondary">试试换个关键词或筛选条件</div>
				</div>
			) : null}

			<div
				className="grid gap-3"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
			>
				{filtered.map((s) => (
					<UpCard
						key={s.id}
						sub={s}
						selected={selection.has(s.id)}
						togglePending={upsert.isPending && upsert.variables?.id === s.id}
						onClick={() => setDrawerSubId(s.id)}
						onToggleSelect={() => toggleSelect(s.id)}
						onToggleEnabled={(on) => toggleEnabled(s, on)}
					/>
				))}
				{/* 在 grid 末尾追加「+ 添加 UP 主」预选卡。仅在没有任何搜索 / 过滤时
				    显示 —— 过滤视图下加这张卡会让人误以为它本来就在过滤集合里。点击
				    等价右上「添加」Btn,打开 NewDialog。视觉走 Targets 的 AddCard 风
				    格(1px dashed + 实色白底 + unicode 加号),保留 UpCard 的圆角 +
				    min-h 让它在 grid 里跟其他卡视觉等高。 */}
				{!q.trim() && filterId === "all" && !groupFilter ? (
					<button
						type="button"
						onClick={() => setShowNewDialog(true)}
						className="flex min-h-[220px] flex-col items-center justify-center rounded-xl border border-dashed border-bn-border px-4 py-5 text-center transition hover:border-bn-pink focus:outline-none focus-visible:ring-2 focus-visible:ring-bn-pink"
					>
						<span className="text-[28px] leading-none text-bn-text-tertiary">＋</span>
						<span className="mt-2 text-[13px] font-semibold text-bn-text-primary">添加 UP 主</span>
						<span className="mt-0.5 text-[11px] text-bn-text-tertiary">UID / 名称搜索</span>
					</button>
				) : null}
			</div>

			{newDraft ? (
				<UpDialog
					sub={newDraft}
					targets={targets}
					mode="create"
					onClose={() => setNewDraft(null)}
					saving={upsert.isPending}
					onSave={(next: Subscription) => {
						upsert.mutate(next, {
							onSuccess: () => setNewDraft(null),
						});
					}}
					onDelete={() => {
						/* 不可达 — create 模式下「移除订阅」按钮已隐藏 */
					}}
				/>
			) : drawerSub ? (
				<UpDialog
					sub={drawerSub}
					targets={targets}
					onClose={() => setDrawerSubId(null)}
					saving={upsert.isPending || del.isPending}
					onSave={(next: Subscription) => {
						upsert.mutate(next, {
							onSuccess: () => setDrawerSubId(null),
						});
					}}
					onDelete={() => {
						del.mutate(drawerSub.id);
					}}
				/>
			) : null}

			{showNewDialog ? (
				<NewSubDialog
					onSubmit={handleNew}
					onCancel={() => {
						setShowNewDialog(false);
						setError(null);
					}}
					pending={upsert.isPending}
					error={error}
					existingUids={new Set(subs.map((s) => s.uid))}
				/>
			) : null}
		</div>
	);
}
