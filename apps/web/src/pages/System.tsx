import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Avatar, Btn } from "../components/atoms";
import {
	Field,
	LogLevelPicker,
	type LogLevelValue,
	TInput,
	TNum,
	TSelect,
} from "../components/forms";
import { GlassBox } from "../components/glass-box";
import { Icon } from "../components/icons";
import { ApiError, api } from "../services/api";
import { useAuthStore } from "../store/auth";
import { BiliLoginStatus, type BiliLoginStatusValue } from "../types/auth";
import type { PushTarget } from "../types/domain";
import type {
	AppConfig,
	GlobalConfig,
	GlobalConfigPatch,
	LogLevel,
	ModuleLogLevels,
} from "../types/globals";

const STATUS_LABELS: Record<BiliLoginStatusValue, string> = {
	[BiliLoginStatus.NOT_LOGIN]: "未登录",
	[BiliLoginStatus.LOADING_LOGIN_INFO]: "正在加载登录信息",
	[BiliLoginStatus.LOGIN_QR]: "等待扫码",
	[BiliLoginStatus.LOGGING_QR]: "正在登录",
	[BiliLoginStatus.LOGGED_IN]: "已登录",
	[BiliLoginStatus.LOGIN_FAILED]: "登录失败",
};

/**
 * 单一状态表达:状态由 GlassBox 的 `accent`(随态变色)+ `badge`
 * (STATUS_LABELS 文案,GlassBox 原生渲染成 Pill)承载。删掉了原先独立的
 * 右上角 StatusPill —— 它会把 STATUS_LABELS[LOGGED_IN]「已登录」与后端
 * snapshot.msg(LoginFlow 对 LOGGED_IN 设的也是「已登录」)拼成「已登录 ·
 * 已登录」。`msg` 现在仅在与状态文案不同时(失败原因 / fetchAccountFailed)
 * 才作小字注脚。
 */
const STATUS_ACCENT: Record<BiliLoginStatusValue, string> = {
	[BiliLoginStatus.NOT_LOGIN]: "#94a3b8",
	[BiliLoginStatus.LOADING_LOGIN_INFO]: "#3b82f6",
	[BiliLoginStatus.LOGIN_QR]: "#f59e0b",
	[BiliLoginStatus.LOGGING_QR]: "#f59e0b",
	[BiliLoginStatus.LOGGED_IN]: "#22c55e",
	[BiliLoginStatus.LOGIN_FAILED]: "#ef4444",
};

function QrCard({ data, msg }: { data: unknown; msg: string }) {
	const src = typeof data === "string" && data.length > 0 ? data : null;
	return (
		<div className="flex flex-col items-center gap-3 rounded-lg border border-black/6 bg-white/55 p-6">
			{src ? (
				<img alt="登录二维码" className="h-56 w-56 rounded bg-white p-2 shadow-bn-card" src={src} />
			) : (
				<div className="flex h-56 w-56 items-center justify-center rounded bg-white text-sm text-bn-text-tertiary">
					二维码加载中…
				</div>
			)}
			<div className="text-[12.5px] text-bn-text-secondary">使用 Bilibili 手机客户端扫码登录</div>
			{msg ? <div className="text-[11px] text-bn-text-tertiary">{msg}</div> : null}
		</div>
	);
}

// ── System settings (app + master) ──────────────────────────────────────────

/**
 * Per-module log overrides shown in 系统 Tab. image / ai already have their own
 * pickers in the Cards / 智能女仆 tabs, so we keep this list to the三个 the
 * user explicitly asked for (core / dynamic / live). image / ai overrides in
 * `app.logLevels` are preserved untouched on writes.
 */
const SYSTEM_MODULES: ReadonlyArray<{
	id: "core" | "dynamic" | "live";
	label: string;
	tone: string;
}> = [
	{ id: "core", label: "core 核心", tone: "#FB7299" },
	{ id: "dynamic", label: "dynamic 动态", tone: "#00AEEC" },
	{ id: "live", label: "live 直播", tone: "#FF6699" },
];

const LOG_LEVEL_NUM: Record<LogLevel, LogLevelValue> = { error: 1, warn: 2, info: 3, debug: 4 };
const NUM_TO_LOG: Record<LogLevelValue, LogLevel> = { 1: "error", 2: "warn", 3: "info", 4: "debug" };

function deepMerge<T>(base: T, patch: GlobalConfigPatch): T {
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const k of Object.keys(patch)) {
		const pv = (patch as Record<string, unknown>)[k];
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
	targets,
	onPatch,
}: {
	draft: GlobalConfig;
	targets: PushTarget[];
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const app = draft.app;
	const master = draft.master;

	const setApp = <K extends keyof AppConfig>(key: K, v: AppConfig[K]) => {
		onPatch({ app: { [key]: v } as Partial<AppConfig> });
	};

	// Only mutate `app.logLevels[id]` for this module; preserve any image / ai
	// overrides that were set elsewhere.
	function setModuleLevel(id: "core" | "dynamic" | "live", value: LogLevelValue | null): void {
		const current: ModuleLogLevels = { ...(app.logLevels ?? {}) };
		if (value === null) delete current[id];
		else current[id] = NUM_TO_LOG[value];
		onPatch({
			app: { logLevels: Object.keys(current).length === 0 ? undefined : current },
		});
	}

	const masterTarget = master.targetId ? targets.find((t) => t.id === master.targetId) : undefined;
	const masterStatus = !master.targetId
		? "未配置 · 出错时不会私聊提醒"
		: masterTarget
			? `→ ${masterTarget.name}`
			: "目标已删除,请重新选择";

	return (
		<GlassBox
			title="Core · 应用"
			subtitle="后端运行参数 + Master 主人账号 · globals.app / globals.master"
			accent="#FB7299"
			icon={<Icon.sliders size={14} />}
			badge="app + master"
		>
			<Field
				label="动态检查频率"
				code="app.dynamicCron"
				hint="cron 表达式 · 默认 */2 * * * * (每 2 分钟)"
			>
				<TInput value={app.dynamicCron} onChange={(v) => setApp("dynamicCron", v)} mono />
			</Field>

			<Field label="日志等级（全局）" code="app.logLevel" hint="未在下方按模块覆盖时的兜底">
				<LogLevelPicker
					value={LOG_LEVEL_NUM[app.logLevel]}
					onChange={(v) => v != null && setApp("logLevel", NUM_TO_LOG[v])}
				/>
			</Field>

			<Field
				label="按模块覆盖"
				code="app.logLevels"
				hint="留「跟随全局」即用 app.logLevel；保存后会立即推到对应模块的 pino 实例,无需重启"
				full
			>
				<div className="grid w-full grid-cols-1 gap-1.5 sm:grid-cols-3">
					{SYSTEM_MODULES.map((m) => {
						const current = app.logLevels?.[m.id];
						return (
							<div
								key={m.id}
								className="flex items-center justify-between gap-2 rounded-md border border-black/5 bg-white/60 px-2.5 py-1.5"
							>
								<span className="flex items-center gap-1.5 text-[12px] font-bold text-bn-text-primary">
									<span
										className="inline-block h-1.5 w-1.5 rounded-full"
										style={{ background: m.tone }}
									/>
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

			<Field label="User-Agent" code="app.userAgent" hint="留空使用默认;遇 -352 风控可换" full>
				<TInput
					value={app.userAgent ?? ""}
					onChange={(v) => setApp("userAgent", v || undefined)}
					placeholder="留空 = 默认"
					mono
				/>
			</Field>

			<Field
				label="登录心跳间隔"
				code="app.healthCheckMinutes"
				hint="每 N 分钟向 B 站 getMyselfInfo 探活；失效会触发 auth-lost + master 通知"
			>
				<TNum
					value={app.healthCheckMinutes}
					onChange={(v) => setApp("healthCheckMinutes", v)}
					min={1}
					max={1440}
					suffix="min"
				/>
			</Field>

			<Field label="历史保留天数" code="app.historyRetentionDays" hint="到期的 jsonl 日志会被清理">
				<TNum
					value={app.historyRetentionDays}
					onChange={(v) => setApp("historyRetentionDays", v)}
					min={1}
					max={365}
					suffix="天"
				/>
			</Field>

			<div className="mt-3 rounded-lg border border-bn-pink/20 bg-gradient-to-br from-bn-pink/8 to-transparent p-3">
				<div className="mb-1.5 flex items-center justify-between">
					<span className="text-[12.5px] font-bold text-bn-text-primary">主人账号 · master</span>
					<span className="text-[10.5px] text-bn-text-tertiary">
						插件遇错误会私聊报告给这个目标
					</span>
				</div>
				<Field label="Master 推送目标" code="master.targetId">
					<TSelect
						value={master.targetId ?? ""}
						onChange={(v) => onPatch({ master: { targetId: v || undefined } })}
						options={[
							{ value: "", label: "未配置" },
							...targets.map((t) => ({ value: t.id, label: t.name })),
						]}
					/>
				</Field>
				<div className="mt-1.5 text-[11px] text-bn-text-secondary">{masterStatus}</div>
			</div>
		</GlassBox>
	);
}

export default function System() {
	const snapshot = useAuthStore((s) => s.snapshot);
	const cookiesRefreshedAt = useAuthStore((s) => s.cookiesRefreshedAt);
	const qc = useQueryClient();
	const [actionError, setActionError] = useState<string | null>(null);

	const status: BiliLoginStatusValue = snapshot?.status ?? BiliLoginStatus.LOADING_LOGIN_INFO;
	const msg = snapshot?.msg ?? "";
	const isQrPhase = status === BiliLoginStatus.LOGIN_QR || status === BiliLoginStatus.LOGGING_QR;
	const loggedIn = status === BiliLoginStatus.LOGGED_IN;
	// 与 header AccountChip 同一数据源:snapshot.data.card = { mid, name, face }。
	const card = loggedIn
		? (snapshot?.data as { card?: { mid?: string; name?: string; face?: string } } | undefined)
				?.card
		: undefined;
	const accountName = card?.name;
	const accountFace = card?.face;
	// msg 仅在与状态文案不同、且非登录失败(失败原因已在红框里)时,作小字注脚。
	const extraMsg =
		msg && msg !== STATUS_LABELS[status] && status !== BiliLoginStatus.LOGIN_FAILED ? msg : "";

	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});

	const [draft, setDraft] = useState<GlobalConfig | null>(null);
	const [systemError, setSystemError] = useState<string | null>(null);

	useEffect(() => {
		if (globalsQuery.data) setDraft(globalsQuery.data);
	}, [globalsQuery.data]);

	const dirty = useMemo(() => {
		if (!draft || !globalsQuery.data) return false;
		return JSON.stringify(draft) !== JSON.stringify(globalsQuery.data);
	}, [draft, globalsQuery.data]);

	function patchDraft(delta: GlobalConfigPatch): void {
		setDraft((d) => (d ? deepMerge(d, delta) : d));
	}

	function discard(): void {
		if (globalsQuery.data) setDraft(globalsQuery.data);
		setSystemError(null);
	}

	const save = useMutation({
		mutationFn: async (next: GlobalConfig) => {
			setSystemError(null);
			try {
				// Only send the scopes this tab actually edits. Posting the whole
				// draft would make the backend enable-check see `defaults.cardStyle`
				// and `defaults.ai` in the patch body and run the puppeteer +
				// chat.completions probes on every save — slow and pointless when
				// the user never touched those fields here.
				// SY1:清空的可选字段经线发显式 `null`(后端 deepMerge 约定 null=
				// 清除)。直接发 undefined 会被 JSON.stringify 丢键,后端当作未改 →
				// 已配的 master.targetId / userAgent / logLevels 无法经 UI 清除。
				await api.patch<GlobalConfig>("/api/globals", {
					app: {
						...next.app,
						userAgent: next.app.userAgent ?? null,
						logLevels: next.app.logLevels ?? null,
					},
					master: { ...next.master, targetId: next.master.targetId ?? null },
				});
			} catch (err) {
				if (err instanceof ApiError) setSystemError(err.message);
				else setSystemError(String(err));
				throw err;
			}
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	function wrap<T>(action: () => Promise<T>): () => Promise<T | undefined> {
		return async () => {
			setActionError(null);
			try {
				return await action();
			} catch (err) {
				setActionError(err instanceof ApiError ? err.message : String(err));
				return undefined;
			}
		};
	}

	const startQr = useMutation({
		mutationFn: wrap(() => api.post<{ ok: true }>("/api/auth/qr")),
	});
	const refresh = useMutation({
		mutationFn: wrap(() => api.post<{ ok: true }>("/api/auth/cookies/refresh")),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["auth-status"] }),
	});
	const reset = useMutation({
		mutationFn: wrap(() => api.post<{ ok: true }>("/api/auth/cookies/reset")),
		// cookies/reset 与 logout 都终结会话:必须清 zustand auth store,否则残留
		// 的 snapshot / cookiesRefreshedAt 让 UI 仍显示已登录账号(后端 jar 已清
		// 的前端镜像同类缺陷)。invalidate 只刷服务端 query,不动 zustand。
		onSuccess: () => {
			useAuthStore.getState().clear();
			qc.invalidateQueries({ queryKey: ["auth-status"] });
		},
	});
	const logout = useMutation({
		mutationFn: wrap(() => api.post<{ ok: true }>("/api/auth/logout")),
		onSuccess: () => {
			useAuthStore.getState().clear();
			qc.invalidateQueries({ queryKey: ["auth-status"] });
		},
	});

	return (
		<div className="bn-anim-fade-in space-y-5">
			<GlassBox
				title="账号 · auth"
				subtitle="B 站账号登录 + Cookie / 会话 · 扫码后实时生效"
				accent={STATUS_ACCENT[status]}
				icon={<Icon.user size={14} />}
				badge={STATUS_LABELS[status]}
			>
				{loggedIn ? (
					<div className="flex items-center gap-3.5">
						<Avatar
							name={accountName ?? "B"}
							color={STATUS_ACCENT[BiliLoginStatus.LOGGED_IN]}
							size={48}
							url={accountFace}
						/>
						<div className="min-w-0 flex-1">
							<div className="truncate text-[14px] font-bold text-bn-text-primary">
								{accountName ?? "已登录账号"}
							</div>
							<div className="mt-0.5 text-[11.5px] text-bn-text-secondary">
								业务核心可正常拉取动态 / 直播 / WBI 签名
							</div>
							{cookiesRefreshedAt ? (
								<div className="mt-0.5 text-[10.5px] text-bn-text-tertiary">
									最近 Cookie 刷新：{new Date(cookiesRefreshedAt).toLocaleString()}
								</div>
							) : null}
						</div>
					</div>
				) : isQrPhase ? (
					<QrCard data={snapshot?.data} msg={msg} />
				) : (
					<div className="text-[12px] text-bn-text-secondary">
						{status === BiliLoginStatus.NOT_LOGIN
							? "尚未登录 B 站账号,点下方「发起扫码登录」开始。"
							: STATUS_LABELS[status]}
					</div>
				)}

				{extraMsg ? <div className="mt-2 text-[11px] text-amber-600">{extraMsg}</div> : null}

				{status === BiliLoginStatus.LOGIN_FAILED ? (
					<div className="mt-2.5 rounded border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
						{msg || "登录失败，可重试。"}
					</div>
				) : null}
				{actionError ? (
					<div className="mt-2.5 rounded border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
						操作失败：{actionError}
					</div>
				) : null}

				<div className="mt-3.5 flex flex-wrap gap-2 border-t border-black/5 pt-3">
					<Btn
						variant="primary"
						disabled={startQr.isPending || isQrPhase || loggedIn}
						onClick={() => startQr.mutate()}
					>
						{startQr.isPending ? "处理中…" : "发起扫码登录"}
					</Btn>
					<Btn
						variant="outline"
						disabled={refresh.isPending || !loggedIn}
						onClick={() => refresh.mutate()}
					>
						{refresh.isPending ? "处理中…" : "刷新 Cookie"}
					</Btn>
					<Btn
						variant="danger"
						disabled={logout.isPending || !loggedIn}
						onClick={() => logout.mutate()}
					>
						{logout.isPending ? "处理中…" : "退出登录"}
					</Btn>
					<Btn variant="danger" disabled={reset.isPending} onClick={() => reset.mutate()}>
						{reset.isPending ? "处理中…" : "重置密钥与 Cookie"}
					</Btn>
				</div>
			</GlassBox>

			{draft ? (
				<>
					{dirty ? (
						<div className="flex items-center justify-end gap-2">
							<span className="text-[11.5px] font-semibold text-bn-pink">未保存</span>
							<Btn variant="outline" size="sm" onClick={discard} disabled={save.isPending}>
								丢弃
							</Btn>
							<Btn
								variant="primary"
								size="sm"
								onClick={() => save.mutate(draft)}
								disabled={save.isPending}
							>
								{save.isPending ? "保存中…" : "保存"}
							</Btn>
						</div>
					) : null}
					{systemError ? (
						<div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
							{systemError}
						</div>
					) : null}
					<SystemSettingsSection
						draft={draft}
						targets={targetsQuery.data ?? []}
						onPatch={patchDraft}
					/>
				</>
			) : globalsQuery.isLoading ? (
				<div className="text-xs text-bn-text-tertiary">加载系统配置中…</div>
			) : globalsQuery.error ? (
				<div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
					拉取 /api/globals 失败：{String((globalsQuery.error as Error).message)}
				</div>
			) : null}

			<details className="rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
				<summary className="cursor-pointer font-medium text-gray-700">原始登录快照</summary>
				<pre className="mt-2 overflow-auto leading-relaxed">
					{JSON.stringify(snapshot ?? { hint: "等待 /api/auth/status" }, null, 2)}
				</pre>
			</details>
		</div>
	);
}
