import {
	AddCard,
	Btn,
	ConfirmDialog,
	EmptyNote,
	ErrorNote,
	Icon,
	Input,
	LoadingBlock,
	ModalShell,
	Pill,
	SELECTED_LANGUAGE,
	SELECTED_TINT_BG,
	TOAST_DURATION_MS,
	Toast,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../services/api";
import { makeEmptySubscription, type PushTarget, type Subscription } from "../types/domain";
import { copyToClipboard } from "../utils/clipboard";
import { GroupEditDialog } from "./up/GroupEditDialog";
import { displayName } from "./up/helpers";
import { computeMenuPosition } from "./up/menu-position";
import { UP_CARD_MIN_H, UpCard } from "./up/UpCard";
import { UpCardMenu } from "./up/UpCardMenu";
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
	// 圆角走皮肤的 pill 轴,别写死 rounded-full —— 像素风皮肤把 radius.pill 调到 0
	// 求一身硬直角,写死的话唯独这排胶囊还是圆的。
	// 底一律**不透明**:这排直接坐在页面背景上,bg-bn-pink/10 那类纱靠白页垫底才
	// 好看,壁纸皮肤把页面换掉后选中态与未分组当场隐形(2026-08-30 主人真机指出
	// 「正常状态反而看不太清」)。粉调用 color-mix 落在 surface 上出,默认装等值。
	const base =
		"inline-flex items-center gap-1.5 rounded-bn-pill px-2.5 py-1 text-bn-xs font-semibold transition";
	// 未分组(muted)= 普通档 + 虚线,**只差线型这一个类**(2026-08-30 主人定案:
	// hover 同样要粉描边,不是只加深文字)。测试用类差集钉着这条,别再各配各的。
	// 选中配方从这里定案后升进了 ui 库 —— 全站选中态说的都是这一句。
	const cls = active
		? SELECTED_LANGUAGE
		: `border ${muted ? "border-dashed " : ""}border-bn-border bg-bn-surface text-bn-text-secondary hover:border-bn-pink/60 hover:text-bn-text-primary`;
	return (
		// 页面里手写的控件不在 packages/ui 那份 skin-hooks 测试的射程内,漏挂了皮肤
		// 就静默够不到它 —— 这一类在本仓库已犯过两回。分组筛选改的是值,挂 chip。
		<button
			type="button"
			onClick={onClick}
			data-bn={active ? "chip chip-active" : "chip"}
			className={`${base} ${cls}`}
		>
			<span className="max-w-35 truncate">{label}</span>
			<span className="tabular-nums text-bn-2xs opacity-70">{count}</span>
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
		<ModalShell
			onCancel={onCancel}
			width={420}
			bodyClassName="p-5"
			title="添加 UP 主"
			description="输入纯数字走 UID 精确查询; 输入名字走搜索,选定后进入配置表单"
		>
			{/* data-tour:「带我做」导览的高亮挂点(TourCompanion) */}
			<div className="flex gap-2" data-tour="subs-search">
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
				<div className="mt-3 rounded-sm border border-bn-warning-border bg-bn-warning-soft p-2 text-xs text-bn-warning-text">
					该 UID 已经在订阅列表中,无需重复添加
				</div>
			) : null}
			{opErr ? <ErrorNote className="mt-3">{opErr}</ErrorNote> : null}
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
			{error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}
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

/**
 * UP 资料的「头像 + 名字/UID/已订阅」身份行 —— UID 预览卡与搜索结果行共用这一份。
 * 收编前两处各抄一遍,连「已订阅」灰标都逐字符相同;第二行内容(粉丝 / 签名的
 * 排法)两处确实不同,走 children。外层容器(卡片 / 可点行)由调用方出。
 */
function UpProfileSummary({
	profile,
	subscribed,
	size,
	children,
}: {
	profile: UpProfileLookup;
	subscribed: boolean;
	/** `md` 给预览卡(48px 头像),`sm` 给搜索结果行(40px)。 */
	size: "sm" | "md";
	children: React.ReactNode;
}) {
	return (
		<>
			<img
				src={profile.avatar}
				alt={profile.name}
				data-bn="avatar"
				className={`${size === "md" ? "h-12 w-12" : "h-10 w-10"} shrink-0 rounded-full bg-bn-surface object-cover`}
				referrerPolicy="no-referrer"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span
						className={`truncate font-bold text-bn-text-primary ${size === "md" ? "text-bn-base" : "text-bn-sm"}`}
					>
						{profile.name}
					</span>
					<span className="text-bn-2xs tabular-nums text-bn-text-tertiary">UID {profile.uid}</span>
					{subscribed ? (
						<Pill size="sm" subtle color="var(--color-bn-text-tertiary)">
							已订阅
						</Pill>
					) : null}
				</div>
				{children}
			</div>
		</>
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
			<UpProfileSummary profile={profile} subscribed={subscribed} size="md">
				<div className="mt-0.5 text-bn-xs text-bn-text-secondary">{fansLabel(profile.fans)}</div>
				{profile.sign ? (
					<div className="mt-1 line-clamp-2 text-bn-xs text-bn-text-tertiary" title={profile.sign}>
						{profile.sign}
					</div>
				) : null}
			</UpProfileSummary>
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
				<EmptyNote>没有匹配的 UP 主</EmptyNote>
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
							// 候选行。**不挂 option-active** —— 这一列没有「选中的那一个」,
							// 灰掉的那些是「已经订阅过、挑不了」,不是选中态。
							data-bn="option"
							className={`flex items-center gap-3 rounded-lg border p-2.5 text-left transition ${
								subscribed
									? "cursor-not-allowed border-bn-border bg-bn-surface-muted opacity-60"
									: "border-bn-border bg-bn-surface hover:border-bn-pink/60 hover:bg-bn-pink/5"
							}`}
						>
							<UpProfileSummary profile={r} subscribed={subscribed} size="sm">
								<div className="mt-0.5 text-bn-2xs text-bn-text-secondary">
									{fansLabel(r.fans)}
									{r.sign ? (
										<span className="ml-2 text-bn-text-tertiary" title={r.sign}>
											· {truncate(r.sign, 30)}
										</span>
									) : null}
								</div>
							</UpProfileSummary>
						</button>
					);
				})
			)}
			<div className="mt-1 flex items-center justify-between text-bn-xs text-bn-text-tertiary">
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
	/** 右键 / 长按打开的快捷菜单:目标订阅 + 触发点坐标。 */
	const [menuAt, setMenuAt] = useState<{ subId: string; x: number; y: number } | null>(null);
	/** 待二次确认的删除(单个来自右键 / 抽屉,多个来自批量)。 */
	const [pendingDelete, setPendingDelete] = useState<{ ids: string[] } | null>(null);
	/** 正在编辑所属分组的订阅。 */
	const [groupEditId, setGroupEditId] = useState<string | null>(null);
	/** 复制 UID 后的轻量提示,自动消失。 */
	const [copyMsg, setCopyMsg] = useState<string | null>(null);

	useEffect(() => {
		if (!copyMsg) return;
		const t = window.setTimeout(() => setCopyMsg(null), TOAST_DURATION_MS);
		return () => window.clearTimeout(t);
	}, [copyMsg]);
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
	const menuSub = menuAt ? (subs.find((s) => s.id === menuAt.subId) ?? null) : null;
	const groupSub = groupEditId ? (subs.find((s) => s.id === groupEditId) ?? null) : null;
	const menuPos =
		menuAt && menuSub
			? computeMenuPosition({
					anchorX: menuAt.x,
					anchorY: menuAt.y,
					menuW: 176,
					menuH: 210,
					viewportW: window.innerWidth,
					viewportH: window.innerHeight,
				})
			: null;

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

	/**
	 * 单字段局部更新走 PATCH /:id(后端 deepMerge,数组整体替换),乐观改本地缓存,
	 * 失败回滚。右键菜单的「启用 / 禁用」「编辑分组」都走它 —— 比整对象 POST 更轻,
	 * 也不会 last-writer-wins 覆盖并发编辑的其它字段。
	 */
	const patchSub = useMutation({
		mutationFn: ({ id, patch }: { id: string; patch: Partial<Subscription> }) =>
			api.patch<Subscription>(`/api/subs/${id}`, patch),
		onMutate: async ({ id, patch }) => {
			await qc.cancelQueries({ queryKey: ["subscriptions"] });
			const prev = qc.getQueryData<Subscription[]>(["subscriptions"]);
			qc.setQueryData<Subscription[]>(["subscriptions"], (old) =>
				(old ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s)),
			);
			return { prev };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.prev) qc.setQueryData(["subscriptions"], ctx.prev);
			setError("操作失败,请稍后重试");
		},
		onSettled: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
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
		// 操作完成后清空勾选,与批量删除一致 —— 保留勾选不符合直觉。
		setSelection(new Set());
	}

	/** 统一执行删除(单个 / 批量),由确认框确认后触发。 */
	function confirmDelete(): void {
		const target = pendingDelete;
		if (!target) return;
		void Promise.allSettled(target.ids.map((id) => api.delete(`/api/subs/${id}`))).then(
			(results) => {
				qc.invalidateQueries({ queryKey: ["subscriptions"] });
				const failed = results.filter((r) => r.status === "rejected").length;
				if (failed > 0) setError(`删除:${failed}/${target.ids.length} 个订阅失败`);
				setSelection((sel) => {
					const next = new Set(sel);
					for (const id of target.ids) next.delete(id);
					return next;
				});
				if (drawerSubId && target.ids.includes(drawerSubId)) setDrawerSubId(null);
			},
		);
		setPendingDelete(null);
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
		<div className="bn-anim-page-in space-y-4">
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
								data-bn={active ? "chip chip-active" : "chip"}
								className={`flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-semibold transition ${
									active
										? "bg-bn-surface text-bn-pink shadow-sm"
										: "text-bn-text-tertiary hover:text-bn-text-primary"
								}`}
							>
								{f.label}
								<span
									className={`text-bn-2xs font-bold ${
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
					// 状态条不是「选中的某一项」,不吃整句选中语汇 —— 只吃那块不透明粉底
					// (旧 bg-bn-pink/12 的纱在壁纸皮肤下会隐形,同分组胶囊踩过的雷)。
					<div
						className={`flex items-center gap-2 rounded-md ${SELECTED_TINT_BG} px-2.5 py-1 text-xs font-semibold text-bn-pink`}
					>
						已选 {selection.size} 项
						<Btn size="sm" variant="ghost" onClick={() => void bulkSetEnabled(true)}>
							批量启用
						</Btn>
						<Btn size="sm" variant="ghost" onClick={() => void bulkSetEnabled(false)}>
							批量禁用
						</Btn>
						<Btn
							size="sm"
							variant="danger"
							onClick={() => setPendingDelete({ ids: [...selection] })}
						>
							批量删除
						</Btn>
					</div>
				) : null}
				{/* 导览「订阅第一个 UP」的页面级灯位 —— 搜索框(subs-search)住在弹窗里,
				    弹窗没开时导览得有个恒在的目标可指;开了弹窗聚光灯自动让位 */}
				<Btn
					data-tour="subs-add"
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
					{/* 这个标题**直接坐在页面背景上**,没有任何底。壁纸皮肤下 tertiary 那一档
					    只剩 2.1~2.7:1(旁边的胶囊看着清楚,是因为它们挂了 btn、拿到了皮肤给的
					    实底),secondary 在壁纸深处也才 3.3:1 —— 无底的文字只有 primary 稳。 */}
					<span className="text-bn-xs font-semibold text-bn-text-primary">分组</span>
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

			{error ? <ErrorNote>{error}</ErrorNote> : null}

			{subsQuery.isLoading ? (
				<LoadingBlock label="正在读取订阅列表" hint="女仆正在点名,看看主人都关注了谁 (｡･ω･｡)ﾉ" />
			) : null}
			{subsQuery.error ? (
				<ErrorNote>加载失败：{String((subsQuery.error as Error).message)}</ErrorNote>
			) : null}
			{subsQuery.data &&
			filtered.length === 0 &&
			(q.trim() || filterId !== "all" || groupFilter) ? (
				<EmptyNote>
					<div className="mb-1 text-sm font-bold text-bn-text-primary">没有匹配的订阅</div>
					<div>试试换个关键词或筛选条件</div>
				</EmptyNote>
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
						onRequestMenu={(pos) => setMenuAt({ subId: s.id, x: pos.x, y: pos.y })}
					/>
				))}
				{/* 在 grid 末尾追加「+ 添加 UP 主」预选卡。仅在没有任何搜索 / 过滤时
				    显示 —— 过滤视图下加这张卡会让人误以为它本来就在过滤集合里。点击
				    等价右上「添加」Btn,打开 NewDialog。视觉走 Targets 的 AddCard 风
				    格(1px dashed + 实色白底 + unicode 加号),圆角与最小高度跟 UpCard
				    对齐,在 grid 里视觉等高。

				    最小高度**必须与 UpCard 引同一个常量**:grid 同行的高度取最高那张卡,
				    这个值从前只写在这儿,于是它一被筛掉,整排 UP 卡就矮一截(真机 220→199)。 */}
				{!q.trim() && filterId === "all" && !groupFilter ? (
					// data-tour 与右上「添加」同名 —— 同名实例是等价入口,导览聚光灯一起亮
					<AddCard
						data-tour="subs-add"
						label="添加 UP 主"
						hint="UID / 名称搜索"
						className={`${UP_CARD_MIN_H} focus:outline-none focus-visible:ring-2 focus-visible:ring-bn-pink`}
						onClick={() => setShowNewDialog(true)}
					/>
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
					saving={upsert.isPending}
					onSave={(next: Subscription) => {
						upsert.mutate(next, {
							onSuccess: () => setDrawerSubId(null),
						});
					}}
					onDelete={() => setPendingDelete({ ids: [drawerSub.id] })}
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

			{menuSub && menuPos ? (
				<UpCardMenu
					enabled={menuSub.enabled}
					x={menuPos.x}
					y={menuPos.y}
					onClose={() => setMenuAt(null)}
					onEdit={() => setDrawerSubId(menuSub.id)}
					onToggleEnabled={() =>
						patchSub.mutate({ id: menuSub.id, patch: { enabled: !menuSub.enabled } })
					}
					onCopyUid={() => {
						void copyToClipboard(menuSub.uid).then((ok) =>
							setCopyMsg(ok ? "已复制 UID" : "复制失败,请手动复制"),
						);
					}}
					onAddToGroup={() => setGroupEditId(menuSub.id)}
					onDelete={() => setPendingDelete({ ids: [menuSub.id] })}
				/>
			) : null}

			{groupSub ? (
				<GroupEditDialog
					allGroups={groupNames}
					current={groupSub.groups}
					saving={patchSub.isPending}
					onConfirm={(next) => {
						patchSub.mutate({ id: groupSub.id, patch: { groups: next } });
						setGroupEditId(null);
					}}
					onCancel={() => setGroupEditId(null)}
				/>
			) : null}

			{pendingDelete ? (
				<ConfirmDialog
					title={
						pendingDelete.ids.length > 1
							? `删除选中的 ${pendingDelete.ids.length} 个订阅?`
							: "删除该订阅?"
					}
					message="删除后该订阅的所有推送配置将一并移除,且不可恢复。"
					confirmLabel="确认删除"
					danger
					onConfirm={confirmDelete}
					onCancel={() => setPendingDelete(null)}
				/>
			) : null}

			{copyMsg ? <Toast>{copyMsg}</Toast> : null}
		</div>
	);
}
