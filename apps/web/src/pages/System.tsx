import type { ConnectionCapabilitiesMap, SettingsResponse } from "@bilibili-notify/contract";
import { HISTORY_RETENTION_DAY_OPTIONS } from "@bilibili-notify/internal/history";
import { isPrivateTarget } from "@bilibili-notify/internal/push-target";
import {
	Avatar,
	Btn,
	ErrorNote,
	GlassBox,
	Icon,
	LoadingBlock,
	ModalShell,
	QrPanel,
	SectionNav,
	StatusDot,
	Toggle,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { BrowserSourceSettings } from "../components/browser-source-settings";
import { CommandsSettings } from "../components/commands-settings";
import {
	Field,
	LogLevelPicker,
	type LogLevelValue,
	Picker,
	TInput,
	TNum,
	TSelect,
} from "../components/forms";
import { LinkPreviewSettings } from "../components/link-preview-settings";
import { OnboardingReopenSection } from "../components/onboarding/reopen-section";
import { UPDATE_SECTION_HASH } from "../components/update/status";
import { UpdateSection } from "../components/update/update-section";
import { AUTH_STATUS_ACCENT, AUTH_STATUS_LABELS, authMessageOf } from "../config/auth-status";
import { AI_PURPLE } from "../config/colors";
import { PUSH_TONE } from "../config/push-features";
import { SECTION_ACCENT } from "../config/section-accents";
import { useSourceAuth } from "../hooks/use-source-auth";
import { useDirtyDraft } from "../hooks/useDirtyDraft";
import { patchSettings, SETTINGS_KEY, useSettings } from "../hooks/useSettings";
import { ApiError, api } from "../services/api";
import { errorTextOf } from "../services/error-text";
import { BILIBILI_SOURCE_KEY, type Connection, type PushTarget } from "../types/domain";
import type {
	GlobalConfig,
	GlobalConfigPatch,
	LoggingSettings,
	LogLevel,
	SettingsPatch,
} from "../types/globals";
import { imageUrl } from "../utils/image-url";
import { BackupSection } from "./backup/BackupSection";
import { SkinSection } from "./skins/SkinSection";
import { buildSystemPatch } from "./system-save-patch";

/**
 * 单一状态表达:状态由 GlassBox 的 `accent`(随态变色)+ `badge`
 * (`AUTH_STATUS_LABELS` 文案,GlassBox 原生渲染成 Pill)承载。服务端给的 `message`
 * (失败 / 失效原因、`confirming` 要主人做什么)只在卡片正文里写一遍,不拼进标签。
 * 状态还没取到(查询在路上)时没有 `AuthState` 可查表,用下面这组占位。
 */
const LOADING_ACCENT = "var(--color-bn-blue)";
const LOADING_LABEL = "读取中";

function QrCard({ dataUrl }: { dataUrl: string }) {
	return (
		// data-tour:「带我做」导览的聚光灯锚点 —— 二维码一出现聚光灯就从登录按钮转移过来
		<QrPanel data-tour="bili-login-qr" src={dataUrl} alt="登录二维码" loading="二维码加载中">
			<div className="text-bn-sm text-bn-text-secondary">使用 Bilibili 手机客户端扫码登录</div>
		</QrPanel>
	);
}

/** 已扫码、等手机上确认时，弹窗里不画二维码，只显示服务端给的那句话。 */
function ConfirmingCard({ message }: { message: string }) {
	return (
		<div data-tour="bili-login-qr" className="py-4 text-center text-bn-sm text-bn-text-secondary">
			{message}
		</div>
	);
}

/**
 * 系统页的五格 —— 按「用户什么时候会来找它」分,不按代码结构分。
 *
 * 十节挤在一页太长(主人 2026-09-12 提的),走 `SectionNav`:xl+ 左竖栏、窄视口
 * 顶部 chip 条,与 Rules / Targets / Ai / Cards 同一件组件。
 */
const SYSTEM_SECTIONS = [
	{ id: "account", label: "账号", desc: "B 站登录 · 主人账号", glyph: Icon.user },
	{ id: "runtime", label: "运行", desc: "后端参数 · 浏览器来源", glyph: Icon.sliders },
	{ id: "messaging", label: "消息", desc: "私聊指令 · 链接解析", glyph: Icon.chat },
	{ id: "appearance", label: "外观", desc: "皮肤", glyph: Icon.palette },
	{ id: "maintenance", label: "维护", desc: "备份 · 更新 · 新手指引", glyph: Icon.wrench },
] as const;

type SystemSectionId = (typeof SYSTEM_SECTIONS)[number]["id"];

/**
 * 页外深链落在哪一格。
 *
 * `/system#update` 有三个来路(概览卡的 `Link` + 两个 toast 的「去更新」)。分格
 * 之后光滚是不够的 —— 不先选中那一格,更新那节根本不在 DOM 里,`scrollIntoView`
 * 滚个空。这张表就是那条接线,`System.rail.test.tsx` 钉着。
 */
const HASH_SECTION: Readonly<Record<string, SystemSectionId>> = {
	[UPDATE_SECTION_HASH]: "maintenance",
};

// ── System settings (logging 与运行参数) ───────────────────────────────────────────────────

/**
 * `logging.levels` 里的按模块覆盖 —— **四个模块全在这一格里设**。
 *
 * image / ai 从前各自躺在「图片渲染」与「智能女仆」页的底部:同一个键分三处编辑,
 * 要调日志得先猜它归哪一页,而那两页的存盘各自还得为这一个键单独带上 `logging` 这半片
 * 补丁。日志是运维口的东西,与那两页在管的「画成什么样 / 用哪家模型」不是一回事。
 */
const SYSTEM_MODULES: ReadonlyArray<{
	id: string;
	label: string;
	tone: string;
}> = [
	// B 站那一格管动态与直播两个引擎(它们共用日志等级表里的一个键),色用推送里直播那一族的 B 站粉,
	// 直接引家族色,不另抄一份。core 不属于任何一族,给它 System 这一屏自己的角光色。
	{ id: "core", label: "core 核心", tone: SECTION_ACCENT.system },
	{ id: BILIBILI_SOURCE_KEY, label: "bilibili B 站", tone: PUSH_TONE.live },
	// 后两格同理不新造色:image 借版式那一族的紫,ai 借它全站通用的 `AI_PURPLE`
	// —— 两抹紫差着一个色相档,并排看得出是两个模块。
	{ id: "image", label: "image 出图", tone: SECTION_ACCENT.message },
	{ id: "ai", label: "ai 女仆", tone: AI_PURPLE },
];

const LOG_LEVEL_NUM: Record<LogLevel, LogLevelValue> = { error: 1, warn: 2, info: 3, debug: 4 };
const NUM_TO_LOG: Record<LogLevelValue, LogLevel> = {
	1: "error",
	2: "warn",
	3: "info",
	4: "debug",
};

/**
 * 草稿层的合并。与线格式同一套语义:**`null` = 删除该键**,缺席 = 不改。
 *
 * 草稿层也必须认 null,否则「关掉一个可选覆盖」在这里就先失败了 —— 从前的写法是
 * 「拷一份、删掉那个键、整份回传」,而整份回传走的是合并,被删的键当场被合回来
 * (同时有两个以上模块覆盖时尤其明显:只剩一个时删空成 undefined 反而歪打正着)。
 */
function deepMerge<T>(base: T, patch: GlobalConfigPatch | SettingsPatch): T {
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const k of Object.keys(patch)) {
		const pv = (patch as Record<string, unknown>)[k];
		if (pv === null) {
			delete out[k];
			continue;
		}
		const bv = out[k];
		if (
			pv != null &&
			typeof pv === "object" &&
			!Array.isArray(pv) &&
			bv != null &&
			typeof bv === "object" &&
			!Array.isArray(bv)
		) {
			out[k] = deepMerge(bv, pv as GlobalConfigPatch);
		} else {
			out[k] = pv;
		}
	}
	return out as T;
}

function SystemSettingsSection({
	draft,
	onPatch,
}: {
	draft: SettingsResponse;
	onPatch: (delta: SettingsPatch) => void;
}) {
	// 核心那几格在 `core` 下,B 站的两格在它自己的设置里、挂在 `bilibili` 键下(ADR-0021 决策 42 下 10-01 的 🔗);
	// 第 4 期起这一节按集成的描述画,B 站那半的形状随之删。
	const logging = draft.core.logging;
	const source = draft.bilibili as {
		dynamicCron: string;
		healthCheckMinutes: number;
	};

	const setLogging = <K extends keyof LoggingSettings>(key: K, v: LoggingSettings[K]) => {
		onPatch({ core: { logging: { [key]: v } as Partial<LoggingSettings> } });
	};
	const setSource = <K extends keyof typeof source>(key: K, v: (typeof source)[K]) => {
		onPatch({ bilibili: { [key]: v } });
	};

	// 只动 `logging.levels[id]` 这一个键,同格里别的模块不受影响(四个模块都在这一格里设)。
	// 退回「跟随全局」发显式 null —— 从前是「拷一份、删掉该键、整份回传」,而整份
	// 回传走合并,被删的键当场合回来:同时有两个以上模块覆盖时就删不掉了。
	function setModuleLevel(id: string, value: LogLevelValue | null): void {
		onPatch({
			core: { logging: { levels: { [id]: value === null ? null : NUM_TO_LOG[value] } } },
		});
	}

	return (
		<GlassBox
			title="Core · 应用"
			subtitle="后端运行参数"
			accent="var(--color-bn-pink)"
			icon={<Icon.sliders size={14} />}
			badge="core"
		>
			<Field code="bilibili.dynamicCron">
				<TInput value={source.dynamicCron} onChange={(v) => setSource("dynamicCron", v)} mono />
			</Field>

			<Field code="core.logging.level">
				<LogLevelPicker
					value={LOG_LEVEL_NUM[logging.level]}
					onChange={(v) => v != null && setLogging("level", NUM_TO_LOG[v])}
				/>
			</Field>

			<Field code="core.logging.levels" full>
				<div className="grid w-full grid-cols-1 gap-1.5 sm:grid-cols-3">
					{SYSTEM_MODULES.map((m) => {
						const current = logging.levels[m.id];
						return (
							<div
								key={m.id}
								className="flex items-center justify-between gap-2 rounded-md border border-bn-border-subtle bg-bn-surface/60 px-2.5 py-1.5"
							>
								<span className="flex items-center gap-1.5 text-bn-sm font-bold text-bn-text-primary">
									<StatusDot size="sm" color={m.tone} />
									{m.label}
								</span>
								<LogLevelPicker
									value={current ? LOG_LEVEL_NUM[current] : null}
									onChange={(v) => setModuleLevel(m.id, v)}
									allowInherit
								/>
							</div>
						);
					})}
				</div>
			</Field>

			<Field code="bilibili.healthCheckMinutes">
				<TNum
					value={source.healthCheckMinutes}
					onChange={(v) => setSource("healthCheckMinutes", v)}
					min={1}
					max={1440}
					suffix="min"
				/>
			</Field>

			{/* 只许七档:选项个数固定,用段选钮组,不用下拉。 */}
			<Field code="core.history.retentionDays">
				<Picker
					value={draft.core.history.retentionDays}
					onChange={(v) => onPatch({ core: { history: { retentionDays: v } } })}
					options={HISTORY_RETENTION_DAY_OPTIONS.map((days) => ({
						value: days,
						label: `${days} 天`,
					}))}
				/>
			</Field>

			<Field code="core.logging.memoryLog.enabled">
				<Toggle
					value={logging.memoryLog.enabled}
					onChange={(v) => onPatch({ core: { logging: { memoryLog: { enabled: v } } } })}
					ariaLabel="内存自检打印"
				/>
			</Field>
		</GlassBox>
	);
}

/**
 * 主人账号 —— 出错时私聊报告给谁。
 *
 * 从「Core · 应用」里拆出来单独一张卡:分区导航下它归**账号**那一格(用户找它时
 * 想的是「谁收报错」,不是「后端跑什么参数」),而 logging.* 归运行那一格。
 */
export function MasterSection({
	draft,
	targets,
	onPatch,
}: {
	draft: Pick<GlobalConfig, "master">;
	targets: PushTarget[];
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const master = draft.master;
	const masterTarget = master.targetId ? targets.find((t) => t.id === master.targetId) : undefined;
	// 主人目标只许指向私聊目标(ADR-0021 决策 57):下拉只列私聊的;当前存着的值要是已经不满足
	// (指向群,或目标没了),就多显示一行不可选的「已失效」,免得下拉悄悄跳去「未配置」。
	const isStale = master.targetId !== undefined && !isPrivateTarget(masterTarget);
	const masterStatus = !master.targetId
		? "未配置 · 出错时不会私聊提醒"
		: !masterTarget
			? "原来的目标已经不在了，请重新选一个私聊目标"
			: !isPrivateTarget(masterTarget)
				? "这个目标不是私聊，女仆没法悄悄告诉主人。请换一个私聊目标"
				: `→ ${masterTarget.name}`;

	return (
		<GlassBox
			title="主人账号 · master"
			subtitle="插件遇错误会私聊报告给这个目标 · globals.master"
			accent="var(--color-bn-pink)"
			icon={<Icon.user size={14} />}
			badge="master"
		>
			<Field code="core.master.targetId">
				<TSelect
					value={master.targetId ?? ""}
					onChange={(v) => onPatch({ master: { targetId: v || undefined } })}
					options={[
						{ value: "", label: "未配置" },
						...(isStale && master.targetId
							? [{ value: master.targetId, label: "已失效", disabled: true }]
							: []),
						...targets
							.filter((t) => isPrivateTarget(t))
							.map((t) => ({ value: t.id, label: t.name })),
					]}
				/>
			</Field>
			<div className="mt-1.5 text-bn-xs text-bn-text-secondary">{masterStatus}</div>
		</GlassBox>
	);
}

export default function System() {
	const auth = useSourceAuth(BILIBILI_SOURCE_KEY);
	const qc = useQueryClient();
	const [actionError, setActionError] = useState<string | null>(null);

	const location = useLocation();
	const [section, setSection] = useState<SystemSectionId>(
		() => HASH_SECTION[location.hash] ?? "account",
	);
	// 带 hash 进来时先落到对应那一格。`location.key` 一起听:已经停在系统页的人
	// 再点一次「去更新」,hash 没变但那是一次新的导航,也该回到维护格 —— 同
	// update-section 里那条滚动 effect 的理由。
	// biome-ignore lint/correctness/useExhaustiveDependencies: location.key 是刻意的重触发条件
	useEffect(() => {
		const wanted = HASH_SECTION[location.hash];
		if (wanted) setSection(wanted);
	}, [location.hash, location.key]);

	const authState = auth.state;
	const loggedIn = authState?.status === "logged-in";
	// 与 header AccountChip 同一数据源:`GET /api/sources/:sourceKey/auth` 的 account(头像是图库引用)。
	const accountName = loggedIn ? auth.account?.name : undefined;
	const accountAvatar =
		loggedIn && auth.account?.avatar ? imageUrl(auth.account.avatar) : undefined;

	// 「这次扫码的弹窗开着」只能由面板自己记:`confirming` 同时表示「已扫码、等手机确认」(弹窗开着时在
	// 弹窗里说)与「开机还没向 B 站确认」(没有弹窗,在卡片上说),服务端的状态分不出这两种,而面板
	// 不靠比对 `message` 的文字分。见到 `awaiting-scan` 置真,见到 `confirming` 保持,其余状态置假;
	// 刷新页面后是假。写成渲染中就地调整,不走 effect —— 否则 `confirming` 到的那一帧卡片先闪一下。
	const [scanSeen, setScanSeen] = useState(false);
	const scanning =
		authState?.status === "awaiting-scan"
			? true
			: authState?.status === "confirming"
				? scanSeen
				: false;
	if (scanning !== scanSeen) setScanSeen(scanning);
	// 弹窗手动关掉后按钮变「继续扫码」可再打开;扫码阶段结束(成功 / 失效)时重置。
	const [qrDismissed, setQrDismissed] = useState(false);
	if (!scanning && qrDismissed) setQrDismissed(false);
	const qrModalOpen = scanning && !qrDismissed;

	const globalsQuery = useSettings();
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const connectionsQuery = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
	});
	// 能力由宿主每分钟补探一轮,面板开着的时候半分钟刷一次,bot 后连上也能看到它变绿。
	const capabilitiesQuery = useQuery({
		queryKey: ["connection-capabilities"],
		queryFn: () => api.get<ConnectionCapabilitiesMap>("/api/connections/capabilities"),
		refetchInterval: 30_000,
	});

	// 草稿是整份设置(核心那份在 `core` 下、B 站的挂在 `bilibili` 下),字段码也按这个形状写(`core.logging.level`)。
	const [draft, setDraft] = useState<SettingsResponse | null>(null);

	useEffect(() => {
		if (globalsQuery.data) setDraft(globalsQuery.data);
	}, [globalsQuery.data]);

	function patchDraft(delta: SettingsPatch): void {
		setDraft((d) => (d ? deepMerge(d, delta) : d));
	}
	/** 只改核心那份的几张卡(主人目标、指令、链接解析)用它:它们认的是核心那份的形状。 */
	function patchCoreDraft(delta: GlobalConfigPatch): void {
		patchDraft({ core: delta });
	}

	const save = useMutation({
		mutationFn: async (next: SettingsResponse) => {
			// 改了哪块发哪块(挑块的规则与理由在 system-save-patch.ts)。草稿是从这份基线长出来
			// 的,没有基线就不会有草稿;真走到这里是状态坏了,宁可报错也别静默发一份空补丁。
			const base = globalsQuery.data;
			if (!base) throw new Error("配置基线尚未加载,无法保存");
			await patchSettings(buildSystemPatch(next, base));
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: SETTINGS_KEY }),
	});

	useDirtyDraft<SettingsResponse>({
		pageKey: "system",
		pageLabel: "Core · 应用",
		draft,
		baseline: globalsQuery.data ?? null,
		onSave: async () => {
			if (draft !== null) await save.mutateAsync(draft);
		},
		onDiscard: () => {
			if (globalsQuery.data) setDraft(globalsQuery.data);
		},
	});

	// 登录 / 退出的错误显示在账号卡的红框里;成功的结果由 `useSourceAuth` 写回查询缓存。
	const startQr = auth.startLogin;
	const logout = auth.logout;
	function reportActionError(err: unknown): void {
		setActionError(err instanceof ApiError ? err.message : String(err));
	}

	const accent = authState ? AUTH_STATUS_ACCENT[authState.status] : LOADING_ACCENT;
	const badge = authState ? AUTH_STATUS_LABELS[authState.status] : LOADING_LABEL;
	// 等待扫码时按钮是「继续扫码」(重开弹窗,不重新发起)。
	const resumable = authState?.status === "awaiting-scan";
	// 卡片正文:扫码弹窗开着时整块不写(状态与进度都在弹窗里)。`expired` / `error` 的话在下面的红框里。
	let bodyText: string | null = null;
	if (!authState) bodyText = auth.isError ? null : "正在读取登录状态";
	else if (authState.status === "logged-out") {
		bodyText = "尚未登录 B 站账号，点下方「发起扫码登录」开始。";
	} else if (authState.status === "confirming" && !qrModalOpen) {
		bodyText = authMessageOf(authState) || "正在确认";
	}
	const modalBody =
		authState?.status === "awaiting-scan" ? (
			<QrCard dataUrl={authState.qr.dataUrl} />
		) : authState?.status === "confirming" ? (
			<ConfirmingCard message={authMessageOf(authState) || "正在确认"} />
		) : null;

	return (
		// 两栏骨架一律走 `xl:grid-bn-rail`,别手写栏宽 —— 栏宽在 --bn-rail-width,皮肤能调。
		<div className="bn-anim-page-in grid gap-4 xl:grid-bn-rail">
			<SectionNav
				heading="系统"
				items={SYSTEM_SECTIONS.map(({ id, label, desc, glyph: Glyph }) => ({
					id,
					label,
					desc,
					icon: <Glyph size={14} />,
				}))}
				activeId={section}
				onPick={(id) => setSection(id as SystemSectionId)}
			/>

			<div className="min-w-0 space-y-5">
				{/* 配置读不下来是整页的事,不是某一格的事 —— 摆在格子外头,停在哪一格都看得见。 */}
				{globalsQuery.error ? (
					<ErrorNote>
						拉取 /api/settings 失败：{String((globalsQuery.error as Error).message)}
					</ErrorNote>
				) : !draft && globalsQuery.isLoading ? (
					<LoadingBlock label="正在读取系统配置" />
				) : null}

				{section === "account" ? (
					<>
						<GlassBox
							title="账号 · auth"
							subtitle="B 站账号登录 + Cookie / 会话 · 扫码后实时生效"
							accent={accent}
							icon={<Icon.user size={14} />}
							badge={badge}
						>
							{loggedIn ? (
								<div className="flex items-center gap-3.5">
									<Avatar
										name={accountName ?? "B"}
										color={AUTH_STATUS_ACCENT["logged-in"]}
										size={48}
										url={accountAvatar}
									/>
									<div className="min-w-0 flex-1">
										<div className="truncate text-bn-md font-bold text-bn-text-primary">
											{accountName ?? "已登录账号"}
										</div>
										<div className="mt-0.5 text-bn-xs text-bn-text-secondary">
											业务核心可正常拉取动态 / 直播 / WBI 签名
										</div>
									</div>
								</div>
							) : bodyText ? (
								// 扫码阶段(弹窗开着时)整块不渲染:状态与进度都在弹窗里(badge 也还挂着),这里再写
								// 一遍纯属重复,还把卡片撑开一截。
								<div className="text-bn-sm text-bn-text-secondary">{bodyText}</div>
							) : null}

							{authState?.status === "expired" || authState?.status === "error" ? (
								<ErrorNote className="mt-2.5">{authState.message}</ErrorNote>
							) : null}
							{auth.isError ? (
								<ErrorNote className="mt-2.5">
									读取登录状态失败：{errorTextOf(auth.error)}
								</ErrorNote>
							) : null}
							{actionError ? (
								<ErrorNote className="mt-2.5">操作失败：{actionError}</ErrorNote>
							) : null}

							<div className="mt-3.5 flex flex-wrap gap-2 border-t border-bn-border-subtle pt-3">
								<Btn
									data-tour="bili-login"
									variant="primary"
									disabled={startQr.isPending || loggedIn || !authState}
									onClick={() => {
										if (resumable) setQrDismissed(false);
										else {
											setActionError(null);
											startQr.mutate(undefined, { onError: reportActionError });
										}
									}}
								>
									{startQr.isPending ? "处理中…" : resumable ? "继续扫码" : "发起扫码登录"}
								</Btn>
								{/* 没登录也能点:cookie 文件解不开时靠它清掉残留。 */}
								<Btn
									variant="danger"
									disabled={logout.isPending || !authState}
									onClick={() => {
										setActionError(null);
										logout.mutate(undefined, { onError: reportActionError });
									}}
								>
									{logout.isPending ? "处理中…" : "退出登录"}
								</Btn>
							</div>
						</GlassBox>

						{/* 二维码弹窗:不撑开页面布局;导览聚光灯经 bili-login-qr 锚点转移到这里 */}
						{qrModalOpen && modalBody ? (
							<ModalShell onCancel={() => setQrDismissed(true)} width={360} title="扫码登录 B 站">
								{modalBody}
							</ModalShell>
						) : null}

						{draft ? (
							<MasterSection
								draft={draft.core}
								targets={targetsQuery.data ?? []}
								onPatch={patchCoreDraft}
							/>
						) : null}

						<details className="rounded-sm border border-bn-border bg-bn-surface-muted p-3 text-bn-sm text-bn-text-secondary">
							<summary className="cursor-pointer font-medium text-bn-text-primary">
								原始登录快照
							</summary>
							<pre className="mt-2 overflow-auto leading-relaxed">
								{JSON.stringify(auth.raw ?? { hint: "等待读取登录状态" }, null, 2)}
							</pre>
						</details>
					</>
				) : null}

				{section === "runtime" ? (
					<>
						{draft ? <SystemSettingsSection draft={draft} onPatch={patchDraft} /> : null}

						<BrowserSourceSettings />
					</>
				) : null}

				{section === "messaging" ? (
					<>
						{draft ? <CommandsSettings draft={draft.core} onPatch={patchCoreDraft} /> : null}

						{draft ? (
							<LinkPreviewSettings
								draft={draft.core}
								onPatch={patchCoreDraft}
								targets={targetsQuery.data ?? []}
								connections={connectionsQuery.data ?? []}
								capabilities={capabilitiesQuery.data ?? {}}
							/>
						) : null}
					</>
				) : null}

				{section === "appearance" ? <SkinSection /> : null}

				{section === "maintenance" ? (
					<>
						<BackupSection />

						<UpdateSection />

						<OnboardingReopenSection />
					</>
				) : null}
			</div>
		</div>
	);
}
