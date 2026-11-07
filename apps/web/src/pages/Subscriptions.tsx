import {
	type ConnectionCapabilitiesMap,
	type CreatorCandidateView,
	type CreatorSearchHintWords,
	type CreatorsResponse,
	creatorSearchHint,
	type SourceEntry,
	type SubscriptionCreateRequest,
	subscriptionIdentityLabel,
} from "@bilibili-notify/contract";
import { formatCount } from "@bilibili-notify/internal/format";
import { colorFromSeed } from "@bilibili-notify/internal/identity";
import {
	AddCard,
	Avatar,
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
	ToneChip,
	WarnNote,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ExtensionSettingsButton } from "../components/extension-settings-button";
import { useProblems } from "../hooks/useProblems";
import { useCoreSettings } from "../hooks/useSettings";
import { useSources } from "../hooks/useSources";
import { useSubscriptionTags } from "../hooks/useSubscriptionTags";
import { useT } from "../i18n";
import { ApiError, api } from "../services/api";
import {
	type Connection,
	makeEmptySubscription,
	type PushTarget,
	type SourceKey,
	type Subscription,
	type SubscriptionTag,
	subscriptionIdentityOf,
} from "../types/domain";
import { copyToClipboard } from "../utils/clipboard";
import { displayName } from "./subscriptions/helpers";
import { computeMenuPosition } from "./subscriptions/menu-position";
import { SUBSCRIPTION_CARD_MIN_HEIGHT, SubscriptionCard } from "./subscriptions/SubscriptionCard";
import { SubscriptionCardMenu } from "./subscriptions/SubscriptionCardMenu";
import { SubscriptionDialog } from "./subscriptions/SubscriptionDialog";
import {
	registeredSources,
	type SubscriptionPlatform,
	subscriptionPlatformOf,
} from "./subscriptions/subscription-source";
import { TagEditDialog } from "./subscriptions/TagEditDialog";
import { TagManagerDialog } from "./subscriptions/TagManagerDialog";

/** 右键菜单只改这两格(启用开关与标签),补丁类型只带它们。 */
type SubscriptionCommonPatch = Partial<Pick<Subscription, "enabled" | "tagIds">>;

type FilterId = "all" | "enabled" | "disabled";

interface FilterDef {
	id: FilterId;
	matches: (s: Subscription) => boolean;
}

/** 胶囊上的字在组件里按 `id` 取(画的时候才取,换了语言跟着变)。 */
const FILTERS: ReadonlyArray<FilterDef> = [
	{ id: "all", matches: () => true },
	{ id: "enabled", matches: (s) => s.enabled },
	{ id: "disabled", matches: (s) => !s.enabled },
];

/** Sentinel for "show subscriptions with no tags attached"(标签 id 是 uuid,撞不上它). */
const UNTAGGED = "__untagged__";

/** 标签表还没读到时的占位 —— 模块级常量,免得每次渲染一个新数组把 useMemo 的依赖冲掉。 */
const NO_TAGS: ReadonlyArray<SubscriptionTag> = [];

function TagChip({
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
	// 好看,壁纸皮肤把页面换掉后选中态与无标签当场隐形(2026-08-30 主人真机指出
	// 「正常状态反而看不太清」)。粉调用 color-mix 落在 surface 上出,默认装等值。
	const base =
		"inline-flex items-center gap-1.5 rounded-bn-pill px-2.5 py-1 text-bn-xs font-semibold transition";
	// 无标签(muted)= 普通档 + 虚线,**只差线型这一个类**(2026-08-30 主人定案:
	// hover 同样要粉描边,不是只加深文字)。测试用类差集钉着这条,别再各配各的。
	// 选中配方从这里定案后升进了 ui 库 —— 全站选中态说的都是这一句。
	const cls = active
		? SELECTED_LANGUAGE
		: `border ${muted ? "border-dashed " : ""}border-bn-border bg-bn-surface text-bn-text-secondary hover:border-bn-pink/60 hover:text-bn-text-primary`;
	return (
		// 页面里手写的控件不在 packages/ui 那份 skin-hooks 测试的射程内,漏挂了皮肤
		// 就静默够不到它 —— 这一类在本仓库已犯过两回。标签筛选改的是值,挂 chip。
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

/** 已经订阅了的身份:来源键 → 它名下的外部 id。 */
type ExistingIdentities = ReadonlyMap<SourceKey, ReadonlySet<string>>;

/**
 * 新建订阅弹窗(4-15 起所有来源同一套流程,订阅源文档「新建订阅弹窗只有一套流程」):选平台 → 一个输入框
 * 搜人(输入原样交给那个来源,`GET /api/sources/:sourceKey/creators`)→ 候选整行点击就进配置弹层。
 *
 * 平台一排列在册的全部来源,只有一个时不画;提示句由 contract 的叫法函数按描述符的 `searchAccepts` 拼。
 * 订阅过的(同一来源 + 同一外部 id)标「已订阅」、挑不了 —— 绝不跨来源。
 */
function NewSubDialog({
	onPick,
	onCancel,
	pending,
	error,
	existing,
	sources,
}: {
	onPick: (source: SourceEntry, candidate: CreatorCandidateView) => void;
	onCancel: () => void;
	pending: boolean;
	error: string | null;
	/** 已经订阅了的身份。候选撞上的标「已订阅」、挑不了。 */
	existing: ExistingIdentities;
	/** 在册的来源(来源表里带 `has` 的那几行),先后照来源表;默认选第一个。 */
	sources: readonly SourceEntry[];
}) {
	const t = useT();
	const [picked, setPicked] = useState<string | undefined>(undefined);
	// 选中的来源中途不在册了(来源表刷新后不在里面)就退回第一个 —— 问一个不在册的来源只会 404。
	const source = sources.find((one) => one.key === picked) ?? sources[0];
	const [candidates, setCandidates] = useState<readonly CreatorCandidateView[] | null>(null);
	const [input, setInput] = useState("");
	const [opErr, setOpErr] = useState<string | null>(null);
	const trimmed = input.trim();

	/**
	 * 搜人(决策 52)。回调挂在 `mutate` 这一发上而不是选项里:换平台 / 改输入时 `reset()` 之后,上一发晚到的
	 * 回应就不会再把候选写回来 —— 否则换到别的平台之后还会冒出一列上一个平台的人。
	 */
	const searching = useMutation({
		mutationFn: ({ key, q }: { key: string; q: string }) =>
			api.get<CreatorsResponse>(
				`/api/sources/${encodeURIComponent(key)}/creators?q=${encodeURIComponent(q)}`,
			),
	});

	function reset(): void {
		setCandidates(null);
		setOpErr(null);
		searching.reset();
	}

	function handleInputChange(next: string): void {
		setInput(next);
		if (candidates || opErr) reset();
	}

	function switchSource(next: string): void {
		if (next === source?.key) return;
		setPicked(next);
		reset();
	}

	function runQuery(): void {
		if (!trimmed || !source) return;
		searching.mutate(
			{ key: source.key, q: trimmed },
			{
				onSuccess: (data) => {
					setCandidates(data.candidates);
					setOpErr(null);
				},
				// 服务端那句话原样摆出来(风控、没登录、超时、来源交回的不合规矩各有各的说法)——
				// 换成一句「查找失败」等于让人对着黑盒猜。
				onError: (err) => {
					setCandidates(null);
					setOpErr(formatApiError(err));
				},
			},
		);
	}

	const busy = searching.isPending || pending;
	const descriptor = source?.descriptor;
	// 搜人提示句的几样按当前语言取(叫法函数在 contract)。列举的拼法也住字典:跟词一起缺句打底,不会拼出半中半英的一句。
	const hintWords: CreatorSearchHintWords = {
		id: t("subs.new.accepts.id"),
		link: t("subs.new.accepts.link"),
		name: t("subs.new.accepts.name"),
		creatorNoun: t("subs.new.creatorNoun"),
		list: (parts) =>
			parts.length < 2
				? parts.join("")
				: t("subs.new.acceptsList", {
						items: parts.slice(0, -1).join(t("subs.new.acceptsSeparator")),
						last: parts.at(-1) ?? "",
					}),
		searchCreator: (creatorNoun) => t("subs.new.searchCreator", { creatorNoun }),
	};

	return (
		<ModalShell
			onCancel={onCancel}
			width={420}
			bodyClassName="p-5"
			title={t("subs.new.title")}
			description={t("subs.new.description", { label: descriptor?.label ?? "" })}
		>
			{sources.length > 1 ? (
				// 与推送目标页「新建连接」那一排平台同一个样子:名字与标识色都取来源表里的描述符。
				<div className="mb-3 flex flex-wrap gap-1.5">
					{sources.map((one) => (
						<ToneChip
							key={one.key}
							tone={one.descriptor.color}
							active={source?.key === one.key}
							onClick={() => switchSource(one.key)}
						>
							{one.descriptor.label}
						</ToneChip>
					))}
				</div>
			) : null}
			{/* data-tour:「带我做」导览的高亮挂点(TourCompanion) */}
			<div className="flex gap-2" data-tour="subs-search">
				<Input
					full
					value={input}
					onChange={handleInputChange}
					placeholder={descriptor ? creatorSearchHint(descriptor, hintWords) : ""}
					icon={<Icon.user size={14} />}
				/>
				<Btn variant="outline" size="sm" onClick={runQuery} disabled={!trimmed || !source || busy}>
					{busy ? t("subs.new.searching") : t("subs.new.search")}
				</Btn>
			</div>
			{opErr ? <ErrorNote className="mt-3">{opErr}</ErrorNote> : null}
			{source && candidates ? (
				<CandidateList
					candidates={candidates}
					descriptor={source.descriptor}
					existing={existing.get(source.key) ?? NO_EXTERNAL_IDS}
					pending={pending}
					onPick={(candidate) => onPick(source, candidate)}
				/>
			) : null}
			{error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}
			<div className="mt-4 flex justify-end gap-2">
				<Btn variant="outline" size="sm" onClick={onCancel} disabled={pending}>
					{candidates ? t("subs.new.close") : t("subs.new.cancel")}
				</Btn>
			</div>
		</ModalShell>
	);
}

/**
 * 候选的「头像 + 名字 / 身份标签 / 已订阅」身份行。第二行(粉丝、简介)由调用方给,走 children。
 */
function UpProfileSummary({
	profile,
	idLabel,
	subscribed,
	children,
}: {
	/** 头像可以没有(候选不一定带),那时退首字头像。 */
	profile: { name: string; avatar?: string };
	/** 名字旁边那一小串身份标签;来源没声明外部 id 的叫法就不写(那串 id 是给机器认的)。 */
	idLabel?: string;
	subscribed: boolean;
	children: React.ReactNode;
}) {
	const t = useT();
	return (
		<>
			{profile.avatar !== undefined ? (
				<img
					src={profile.avatar}
					alt={profile.name}
					data-bn="avatar"
					className="h-10 w-10 shrink-0 rounded-full bg-bn-surface object-cover"
					referrerPolicy="no-referrer"
				/>
			) : (
				<Avatar name={profile.name} color={colorFromSeed(profile.name)} size={40} />
			)}
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-bn-sm font-bold text-bn-text-primary">{profile.name}</span>
					{idLabel ? (
						<span className="text-bn-2xs tabular-nums text-bn-text-tertiary">{idLabel}</span>
					) : null}
					{subscribed ? (
						<Pill size="sm" subtle color="var(--color-bn-text-tertiary)">
							{t("subs.candidate.subscribed")}
						</Pill>
					) : null}
				</div>
				{children}
			</div>
		</>
	);
}

/** 结果行的底与边。 */
function resultRowClass(subscribed: boolean): string {
	return `flex items-center gap-3 rounded-lg border p-2.5 text-left transition ${
		subscribed
			? "cursor-not-allowed border-bn-border bg-bn-surface-muted opacity-60"
			: "border-bn-border bg-bn-surface hover:border-bn-pink/60 hover:bg-bn-pink/5"
	}`;
}

const NO_EXTERNAL_IDS: ReadonlySet<string> = new Set();

/**
 * 搜人交回的候选(ADR-0019 决策 52):整行点击就进配置弹层。最多 10 条,不翻页(契约定的);已经订阅过的
 * (同一个来源 + 同一个外部 id)标「已订阅」、挑不了。
 */
function CandidateList({
	candidates,
	descriptor,
	existing,
	pending,
	onPick,
}: {
	candidates: readonly CreatorCandidateView[];
	/** 候选所属来源的描述符:身份标签的叫法从这里取。 */
	descriptor: SourceEntry["descriptor"];
	existing: ReadonlySet<string>;
	pending: boolean;
	onPick: (candidate: CreatorCandidateView) => void;
}) {
	const t = useT();
	return (
		<div className="mt-4 flex flex-col gap-1.5">
			{candidates.length === 0 ? (
				<EmptyNote>{t("subs.new.noMatch")}</EmptyNote>
			) : (
				candidates.map((c) => {
					const subscribed = existing.has(c.externalId);
					const disabled = subscribed || pending;
					return (
						<button
							key={c.externalId}
							type="button"
							onClick={() => !disabled && onPick(c)}
							disabled={disabled}
							// 候选行。**不挂 option-active** —— 这一列没有「选中的那一个」,
							// 灰掉的那些是「已经订阅过、挑不了」,不是选中态。
							data-bn="option"
							className={resultRowClass(subscribed)}
						>
							<UpProfileSummary
								profile={{
									name: c.name,
									...(c.avatarUrl === undefined ? {} : { avatar: c.avatarUrl }),
								}}
								{...(descriptor.externalIdNoun?.trim()
									? { idLabel: subscriptionIdentityLabel(c, descriptor) }
									: {})}
								subscribed={subscribed}
							>
								{c.followers !== undefined || c.bio ? (
									<div className="mt-0.5 text-bn-2xs text-bn-text-secondary">
										{c.followers !== undefined
											? t("subs.candidate.followers", { count: formatCount(c.followers) })
											: null}
										{c.bio ? (
											<span className="ml-2 text-bn-text-tertiary" title={c.bio}>
												· {truncate(c.bio, 30)}
											</span>
										) : null}
									</div>
								) : null}
							</UpProfileSummary>
						</button>
					);
				})
			)}
		</div>
	);
}

/**
 * 用选中的候选预填新建请求资料(ADR-0019 决策 49):头像是候选的 data URL,它是个网址,放 `avatarUrl`;
 * 建成之后服务端把它存进图库、回来的资料里换成图库引用 `avatar`。没有头像就缺这一格(头像件见没有退首字)。
 *
 * 候选没带粉丝数就**不带这一格**:编一个 `0` 出来,卡上就会写「0 粉丝」这种假话。
 */
function candidateProfile(
	candidate: CreatorCandidateView,
): NonNullable<SubscriptionCreateRequest["cachedProfile"]> {
	return {
		name: candidate.name,
		...(candidate.avatarUrl ? { avatarUrl: candidate.avatarUrl } : {}),
		...(candidate.followers !== undefined ? { followers: candidate.followers } : {}),
	};
}

interface SubscriptionCreateDraft {
	subscription: Subscription;
	cachedProfile: NonNullable<SubscriptionCreateRequest["cachedProfile"]>;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 查人失败显示什么:服务端的 `message` 本身就是给人看的中文(查无此人、B 站没就绪、搜索词为空、
 * 无法访问 B 站……各说各的),原样显示。从前这里按状态码换成固定句子,会把服务端的原话盖掉。
 */
function formatApiError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export default function Subscriptions() {
	const t = useT();
	const filterLabels: Record<FilterId, string> = {
		all: t("subs.filter.all"),
		enabled: t("subs.filter.enabled"),
		disabled: t("subs.filter.disabled"),
	};
	const qc = useQueryClient();
	const problemsQuery = useProblems();
	const invalidSubscriptions =
		problemsQuery.data?.problems?.filter(
			(problem) => problem.reporter === "core" && problem.code === "subscriptions_invalid",
		) ?? [];
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subscriptions"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	// 目标的平台取自它挂着的连接(订阅抽屉里的图标与 @全体 能力都读它);与推送目标页共用同一个 ["connections"] 缓存。
	const connectionsQuery = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
	});
	// 连接能力表:订阅抽屉的 @全体 开关读目标所挂连接的 atAll 能力;与系统页共用同一个缓存。
	const capabilitiesQuery = useQuery({
		queryKey: ["connection-capabilities"],
		queryFn: () => api.get<ConnectionCapabilitiesMap>("/api/connections/capabilities"),
		refetchInterval: 30_000,
	});
	// 全局特性开关:订阅没覆盖的那几把继承它(卡片胶囊与配置弹层都按它算)。与规则页同一个 ["settings"] 缓存;
	// 没读到时回落出厂值 —— 面板没有全局特性开关的界面,通常就是出厂值,唯独直播拆键把旧的周期推送迁成了全局开。
	const globalsQuery = useCoreSettings();
	const globalFeatures = globalsQuery.data?.defaults?.features;
	// 标签表(ADR-0034):筛选胶囊、卡片角标、挑标签的弹框都读它。没读到时是 `undefined` —— 此时没有标签胶囊可画,
	// 弹框也不许新建(PUT 整张换,拿不到旧表就建会把表洗空)。
	const tagsQuery = useSubscriptionTags();
	const tags = tagsQuery.data;
	const subs = subsQuery.data ?? [];
	const targets = targetsQuery.data ?? [];
	// 拓展列表只是锦上添花(平台选择、拓展订阅的平台与「没开」),拿不到就不重试 —— 同推送目标页。
	/** 没回来(还在读 / 读失败)时是 `undefined`:那时不下「拓展没在跑」的结论。 */
	// 来源表:平台的名字、颜色、叫法、特性(「在不在跑」仍看拓展列表)。
	const sourceTable = useSources().data?.sources;
	// 新建弹窗的平台一排:在册的全部来源(B 站也是其中一个)。
	const sources = useMemo(() => registeredSources(sourceTable), [sourceTable]);
	const platformOf = (s: Subscription): SubscriptionPlatform =>
		subscriptionPlatformOf(subscriptionIdentityOf(s), sourceTable);
	const existing = useMemo(() => {
		const out = new Map<SourceKey, Set<string>>();
		for (const s of subs) {
			const { sourceKey, externalId } = subscriptionIdentityOf(s);
			const ids = out.get(sourceKey) ?? new Set<string>();
			ids.add(externalId);
			out.set(sourceKey, ids);
		}
		return out;
	}, [subs]);

	const [q, setQ] = useState("");
	const [filterId, setFilterId] = useState<FilterId>("all");
	/** 当前选中的标签筛选:标签 id、{@link UNTAGGED},或 `null`(全部)。 */
	const [tagFilter, setTagFilter] = useState<string | null>(null);
	const [selection, setSelection] = useState<Set<string>>(new Set());
	const [drawerSubId, setDrawerSubId] = useState<string | null>(null);
	/** 抽屉打开时滚到哪一节;只有 `?open=` 直达(无目标小卡的「去配置」)会要求滚到推送目标。 */
	const [drawerFocus, setDrawerFocus] = useState<"targets" | undefined>(undefined);
	const [searchParams, setSearchParams] = useSearchParams();
	const openParam = searchParams.get("open");
	// `/subs?open=<订阅 id>`:订阅列表到手后打开那位 UP 的抽屉并滚到推送目标;悬空 id 忽略。
	// 参数用完即清(replace,不留历史),刷新不会再弹一次。
	useEffect(() => {
		if (!openParam || !subsQuery.data) return;
		if (subsQuery.data.some((s) => s.id === openParam)) {
			setDrawerSubId(openParam);
			setDrawerFocus("targets");
		}
		setSearchParams(
			(prev) => {
				prev.delete("open");
				return prev;
			},
			{ replace: true },
		);
	}, [openParam, subsQuery.data, setSearchParams]);
	/** 右键 / 长按打开的快捷菜单:目标订阅 + 触发点坐标。 */
	const [menuAt, setMenuAt] = useState<{ subId: string; x: number; y: number } | null>(null);
	/** 待二次确认的删除(单个来自右键 / 抽屉,多个来自批量)。 */
	const [pendingDelete, setPendingDelete] = useState<{ ids: string[] } | null>(null);
	/** 标签表管理与单条订阅挑标签分别拥有自己的弹窗。 */
	const [managingTags, setManagingTags] = useState(false);
	const [tagEditId, setTagEditId] = useState<string | null>(null);
	/** 复制 UID 后的轻量提示,自动消失。 */
	const [copyMsg, setCopyMsg] = useState<string | null>(null);

	useEffect(() => {
		if (!copyMsg) return;
		const timer = window.setTimeout(() => setCopyMsg(null), TOAST_DURATION_MS);
		return () => window.clearTimeout(timer);
	}, [copyMsg]);
	const [showNewDialog, setShowNewDialog] = useState(false);
	/**
	 * Staged 草稿:点 NewSubDialog 搜索结果后,不立即 POST,而是把订阅配置与候选的创建资料
	 * 分开放这里,接着打开 SubscriptionDialog 让用户配 routing / features / template 等;点
	 * 「创建订阅」才组装请求并落盘。关闭/取消则丢弃,UP 不会出现在订阅列表。
	 */
	const [newDraft, setNewDraft] = useState<SubscriptionCreateDraft | null>(null);
	const [error, setError] = useState<string | null>(null);

	const filterDef = FILTERS.find((f) => f.id === filterId) ?? FILTERS[0];

	// 标签的口径(ADR-0034):胶囊**照标签表的顺序**一枚一枚出(没人挂的空标签也在,计数 0),按 id 计数与筛选;
	// 一条订阅可以挂好几个标签,各计一次;另有一个合成的「无标签」桶收没挂任何标签的订阅。
	const tagTable = tags ?? NO_TAGS;
	const tagStats = useMemo(() => {
		const counts = new Map<string, number>();
		let untagged = 0;
		for (const s of subs) {
			if (s.tagIds.length === 0) {
				untagged++;
			} else {
				for (const id of s.tagIds) counts.set(id, (counts.get(id) ?? 0) + 1);
			}
		}
		return { counts, untagged };
	}, [subs]);
	// 选着的那个标签被别处删掉了(标签表重取之后它不在了):退回「全部」,别留一个看不见也点不掉的筛选。
	const activeTagFilter =
		tagFilter === null || tagFilter === UNTAGGED || tagTable.some((tag) => tag.id === tagFilter)
			? tagFilter
			: null;

	const filtered = useMemo(() => {
		const ql = q.trim().toLowerCase();
		return subs.filter((s) => {
			if (!filterDef.matches(s)) return false;
			if (activeTagFilter === UNTAGGED && s.tagIds.length > 0) return false;
			if (activeTagFilter && activeTagFilter !== UNTAGGED && !s.tagIds.includes(activeTagFilter)) {
				return false;
			}
			if (!ql) return true;
			return (
				// 按身份里的外部 id 搜:B 站就是 uid,拓展订阅没有 uid、是它的外部 id(ADR-0019 决策 9)。
				subscriptionIdentityOf(s).externalId.toLowerCase().includes(ql) ||
				displayName(s, subscriptionPlatformOf(subscriptionIdentityOf(s), sourceTable))
					.toLowerCase()
					.includes(ql) ||
				(s.notes ?? "").toLowerCase().includes(ql)
			);
		});
	}, [subs, filterDef, q, activeTagFilter, sourceTable]);

	const filterCounts: Record<FilterId, number> = {
		all: subs.length,
		enabled: subs.filter((s) => s.enabled).length,
		disabled: subs.filter((s) => !s.enabled).length,
	};

	const drawerSub = drawerSubId ? (subs.find((s) => s.id === drawerSubId) ?? null) : null;
	const menuSub = menuAt ? (subs.find((s) => s.id === menuAt.subId) ?? null) : null;
	const tagSub = tagEditId ? (subs.find((s) => s.id === tagEditId) ?? null) : null;
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
		mutationFn: async (body: Subscription | SubscriptionCreateRequest) => {
			setError(null);
			try {
				await api.post<Subscription[]>("/api/subscriptions", body);
				return body;
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
	 * 失败回滚。右键菜单的「启用 / 禁用」「编辑标签」都走它 —— 比整对象 POST 更轻,
	 * 也不会 last-writer-wins 覆盖并发编辑的其它字段。
	 */
	const patchSub = useMutation({
		mutationFn: ({ id, patch }: { id: string; patch: SubscriptionCommonPatch }) =>
			api.patch<Subscription>(`/api/subscriptions/${id}`, patch),
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
			setError(t("subs.error.saveFailed"));
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
				return api.post<Subscription[]>("/api/subscriptions", { ...s, enabled: on });
			}),
		);
		// allSettled 结果此前被丢弃 → 部分失败完全不可见。上报失败计数。
		const failed = results.filter((r) => r.status === "rejected").length;
		if (failed > 0) {
			setError(
				on
					? t("subs.error.bulkEnableFailed", { failed, total: ids.length })
					: t("subs.error.bulkDisableFailed", { failed, total: ids.length }),
			);
		}
		qc.invalidateQueries({ queryKey: ["subscriptions"] });
		// 操作完成后清空勾选,与批量删除一致 —— 保留勾选不符合直觉。
		setSelection(new Set());
	}

	/** 统一执行删除(单个 / 批量),由确认框确认后触发。 */
	function confirmDelete(): void {
		const target = pendingDelete;
		if (!target) return;
		void Promise.allSettled(target.ids.map((id) => api.delete(`/api/subscriptions/${id}`))).then(
			(results) => {
				qc.invalidateQueries({ queryKey: ["subscriptions"] });
				const failed = results.filter((r) => r.status === "rejected").length;
				if (failed > 0) {
					setError(t("subs.error.deleteFailed", { failed, total: target.ids.length }));
				}
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

	/**
	 * 挑中一个候选:不立即 upsert —— 构造草稿放进 newDraft,关掉新建弹窗,打开 SubscriptionDialog(create 模式),让主人先配
	 * 路由 / 特性 / 模板,点「创建订阅」才落盘。草稿的身份是 `(来源键, 候选的外部 id)`,资料用候选预填。
	 */
	function handleNewCandidate(source: SourceEntry, candidate: CreatorCandidateView): void {
		const fresh = makeEmptySubscription({
			sourceKey: source.key,
			externalId: candidate.externalId,
		});
		setNewDraft({
			subscription: fresh,
			cachedProfile: candidateProfile(candidate),
		});
		setShowNewDialog(false);
	}

	return (
		<div className="bn-anim-page-in space-y-4">
			<div className="flex flex-wrap items-center gap-2.5">
				<Input
					value={q}
					onChange={setQ}
					placeholder={t("subs.search.placeholder")}
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
								className={`flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-bn-sm font-semibold transition ${
									active
										? "bg-bn-surface text-bn-pink shadow-sm"
										: "text-bn-text-tertiary hover:text-bn-text-primary"
								}`}
							>
								{filterLabels[f.id]}
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
					// (旧 bg-bn-pink/12 的纱在壁纸皮肤下会隐形,同标签胶囊踩过的雷)。
					<div
						className={`flex items-center gap-2 rounded-md ${SELECTED_TINT_BG} px-2.5 py-1 text-bn-sm font-semibold text-bn-pink`}
					>
						{t("subs.selection.count", { count: selection.size })}
						<Btn size="sm" variant="ghost" onClick={() => void bulkSetEnabled(true)}>
							{t("subs.selection.enable")}
						</Btn>
						<Btn size="sm" variant="ghost" onClick={() => void bulkSetEnabled(false)}>
							{t("subs.selection.disable")}
						</Btn>
						<Btn
							size="sm"
							variant="danger"
							onClick={() => setPendingDelete({ ids: [...selection] })}
						>
							{t("subs.selection.delete")}
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
					{t("subs.add")}
				</Btn>
			</div>

			<div className="flex flex-wrap items-center gap-1.5">
				{/* 这个标题**直接坐在页面背景上**,没有任何底。壁纸皮肤下 tertiary 那一档
					    只剩 2.1~2.7:1(旁边的胶囊看着清楚,是因为它们挂了 btn、拿到了皮肤给的
					    实底),secondary 在壁纸深处也才 3.3:1 —— 无底的文字只有 primary 稳。 */}
				<span className="text-bn-xs font-semibold text-bn-text-primary">
					{t("subs.tags.title")}
				</span>
				<TagChip
					label={t("subs.tags.all")}
					count={subs.length}
					active={activeTagFilter === null}
					onClick={() => setTagFilter(null)}
				/>
				{tagTable.map((tag) => (
					<TagChip
						key={tag.id}
						label={tag.name}
						count={tagStats.counts.get(tag.id) ?? 0}
						active={activeTagFilter === tag.id}
						onClick={() => setTagFilter(tag.id)}
					/>
				))}
				{tagStats.untagged > 0 ? (
					<TagChip
						label={t("subs.tags.untagged")}
						count={tagStats.untagged}
						active={activeTagFilter === UNTAGGED}
						onClick={() => setTagFilter(UNTAGGED)}
						muted
					/>
				) : null}
				<div className="ml-auto">
					<Btn
						size="sm"
						variant="outline"
						icon={<Icon.sliders size={13} />}
						onClick={() => setManagingTags(true)}
					>
						{t("subscriptionTags.manage")}
					</Btn>
				</div>
			</div>

			{invalidSubscriptions.map((problem) => (
				<WarnNote key={`${problem.reporter}:${problem.code}`}>{problem.message}</WarnNote>
			))}
			{error ? <ErrorNote>{error}</ErrorNote> : null}

			{subsQuery.isLoading ? (
				<LoadingBlock label={t("subs.list.loading")} hint={t("subs.list.loadingHint")} />
			) : null}
			{subsQuery.error ? (
				<ErrorNote>
					{t("subs.list.loadFailed", { reason: String((subsQuery.error as Error).message) })}
				</ErrorNote>
			) : null}
			{subsQuery.data &&
			filtered.length === 0 &&
			(q.trim() || filterId !== "all" || activeTagFilter) ? (
				<EmptyNote>
					<div className="mb-1 text-bn-base font-bold text-bn-text-primary">
						{t("subs.empty.title")}
					</div>
					<div>{t("subs.empty.hint")}</div>
				</EmptyNote>
			) : null}

			<div
				className="grid gap-3"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
			>
				{filtered.map((s) => (
					<SubscriptionCard
						key={s.id}
						sub={s}
						selected={selection.has(s.id)}
						togglePending={upsert.isPending && upsert.variables?.id === s.id}
						onClick={() => setDrawerSubId(s.id)}
						onToggleSelect={() => toggleSelect(s.id)}
						onToggleEnabled={(on) => toggleEnabled(s, on)}
						onRequestMenu={(pos) => setMenuAt({ subId: s.id, x: pos.x, y: pos.y })}
						platform={platformOf(s)}
						extensionSettings={<ExtensionSettingsButton id={subscriptionIdentityOf(s).sourceKey} />}
						tags={tags}
						globalFeatures={globalFeatures}
					/>
				))}
				{/* 在 grid 末尾追加「+ 添加 UP 主」预选卡。仅在没有任何搜索 / 过滤时
				    显示 —— 过滤视图下加这张卡会让人误以为它本来就在过滤集合里。点击
				    等价右上「添加」Btn,打开 NewDialog。视觉走 Targets 的 AddCard 风
				    格(1px dashed + 实色白底 + unicode 加号),圆角与最小高度跟 SubscriptionCard
				    对齐,在 grid 里视觉等高。

				    最小高度**必须与 SubscriptionCard 引同一个常量**:grid 同行的高度取最高那张卡,
				    这个值从前只写在这儿,于是它一被筛掉,整排 UP 卡就矮一截(真机 220→199)。 */}
				{!q.trim() && filterId === "all" && !activeTagFilter ? (
					// data-tour 与右上「添加」同名 —— 同名实例是等价入口,导览聚光灯一起亮
					<AddCard
						data-tour="subs-add"
						label={t("subs.addCard.label")}
						hint={t("subs.addCard.hint")}
						className={`${SUBSCRIPTION_CARD_MIN_HEIGHT} focus:outline-none focus-visible:ring-2 focus-visible:ring-bn-pink`}
						onClick={() => setShowNewDialog(true)}
					/>
				) : null}
			</div>

			{newDraft ? (
				<SubscriptionDialog
					sub={newDraft.subscription}
					createProfile={newDraft.cachedProfile}
					targets={targets}
					connections={connectionsQuery.data}
					capabilities={capabilitiesQuery.data}
					platform={platformOf(newDraft.subscription)}
					tags={tags}
					globalFeatures={globalFeatures}
					mode="create"
					onClose={() => setNewDraft(null)}
					saving={upsert.isPending}
					onSave={(next: Subscription) => {
						const { cachedProfile: _responseProfile, problems: _problems, ...subscription } = next;
						const request: SubscriptionCreateRequest = {
							...subscription,
							cachedProfile: newDraft.cachedProfile,
						};
						upsert.mutate(request, {
							onSuccess: () => setNewDraft(null),
						});
					}}
					onDelete={() => {
						/* 不可达 — create 模式下「移除订阅」按钮已隐藏 */
					}}
				/>
			) : drawerSub ? (
				<SubscriptionDialog
					sub={drawerSub}
					targets={targets}
					connections={connectionsQuery.data}
					capabilities={capabilitiesQuery.data}
					platform={platformOf(drawerSub)}
					tags={tags}
					globalFeatures={globalFeatures}
					focusSection={drawerFocus}
					onClose={() => {
						setDrawerSubId(null);
						setDrawerFocus(undefined);
					}}
					saving={upsert.isPending}
					onSave={(next: Subscription) => {
						upsert.mutate(next, {
							onSuccess: () => {
								setDrawerSubId(null);
								setDrawerFocus(undefined);
							},
						});
					}}
					onDelete={() => setPendingDelete({ ids: [drawerSub.id] })}
				/>
			) : null}

			{showNewDialog ? (
				<NewSubDialog
					onPick={handleNewCandidate}
					onCancel={() => {
						setShowNewDialog(false);
						setError(null);
					}}
					pending={upsert.isPending}
					error={error}
					existing={existing}
					sources={sources}
				/>
			) : null}

			{menuSub && menuPos ? (
				<SubscriptionCardMenu
					enabled={menuSub.enabled}
					x={menuPos.x}
					y={menuPos.y}
					onClose={() => setMenuAt(null)}
					onEdit={() => setDrawerSubId(menuSub.id)}
					onToggleEnabled={() =>
						patchSub.mutate({ id: menuSub.id, patch: { enabled: !menuSub.enabled } })
					}
					copyLabel={t("sourceUi.pages.up.UpCardMenu.label.4", {
						value1: platformOf(menuSub).externalIdNoun?.trim() || "ID",
					})}
					onCopyExternalId={() => {
						void copyToClipboard(menuSub.identity.externalId).then((ok) =>
							setCopyMsg(ok ? t("subs.copy.done") : t("subs.copy.failed")),
						);
					}}
					onEditTags={() => setTagEditId(menuSub.id)}
					onDelete={() => setPendingDelete({ ids: [menuSub.id] })}
				/>
			) : null}

			{managingTags ? (
				<TagManagerDialog
					subscriptions={subsQuery.isError ? undefined : subsQuery.data}
					onClose={() => setManagingTags(false)}
				/>
			) : null}

			{tagSub ? (
				<TagEditDialog
					tags={tags}
					current={tagSub.tagIds}
					saving={patchSub.isPending}
					onConfirm={(next) => {
						patchSub.mutate({ id: tagSub.id, patch: { tagIds: next } });
						setTagEditId(null);
					}}
					onCancel={() => setTagEditId(null)}
				/>
			) : null}

			{pendingDelete ? (
				<ConfirmDialog
					title={
						pendingDelete.ids.length > 1
							? t("subs.delete.titleMany", { count: pendingDelete.ids.length })
							: t("subs.delete.titleOne")
					}
					message={t("subs.delete.message")}
					confirmLabel={t("subs.delete.confirm")}
					danger
					onConfirm={confirmDelete}
					onCancel={() => setPendingDelete(null)}
				/>
			) : null}

			{copyMsg ? <Toast>{copyMsg}</Toast> : null}
		</div>
	);
}
