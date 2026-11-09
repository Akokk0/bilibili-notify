import {
	canApplyUpdate,
	type UpdateApplyResponse,
	type UpdateFailureCode,
	type UpdateStatusView,
} from "@bilibili-notify/contract";
import type { UpdateSettings } from "@bilibili-notify/internal";
import {
	BELOW_HEADER_TOP,
	Btn,
	ErrorNote,
	GlassBox,
	HintNote,
	Icon,
	LoadingBlock,
	Picker,
	Toggle,
} from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { SECTION_ACCENT } from "../../config/section-accents";
import { HEALTH_QUERY_KEY } from "../../hooks/useBackendReachable";
import { useScrollToHash } from "../../hooks/useScrollToHash";
import { patchCoreSettings, SETTINGS_KEY, useCoreSettings } from "../../hooks/useSettings";
import { i18n, useT } from "../../i18n";
import { api } from "../../services/api";
import { externalLinkClick } from "../../utils/externalLink";
import { MirrorPicker } from "./mirror-picker";
import { DEFAULT_RESTART_WAIT, type RestartWait, useRestartStore } from "./restart";
import { phaseLabel, UPDATE_QUERY_KEY, UPDATE_SECTION_HASH, useUpdateStatus } from "./status";

/**
 * 系统页「应用内更新」一节。
 *
 * **这一节的设置刻意不走页面草稿**(其余分区那套「改了 → 灵动岛 → 保存」)。
 * 服务端做检查更新时读的是**已落盘**的设置,草稿里改了加速前缀却还没保存就点
 * 「检查更新」,结果仍会失败 —— 而用户刚刚明明改过。这种「改了不算数」比多一种
 * 保存模型更难解释,所以这里改一下存一下。同页的「新手指引」一节也是这么干的。
 *
 * 另一条贯穿全节的规矩:**只有验签失败才弹红字**。连不上、我们自己发错了清单,
 * 都是中性旁注 —— 把代理站抽风渲染成安全警告,只会训练用户忽略真正的那一次。
 */

const CHANNEL_OPTIONS = [
	{
		value: "stable",
		get label() {
			return i18n.t("panelUi.components.update.update-section.1");
		},
	},
	{
		value: "prerelease",
		get label() {
			return i18n.t("panelUi.components.update.update-section.2");
		},
	},
];

/**
 * 报错文案。措辞按归因分档,别混成一句「更新失败」。
 *
 * 写成 `Record<UpdateFailureCode, …>` 而不是带兜底的 switch:契约里加一档新归因时,
 * 这里要么被编译器点名、要么就悄悄以「这次没成」发出去 —— 而后者正是这一节存在的
 * 理由的反面(同页的 `phaseLabel` 与加速站那张 `FAILURE_LABEL` 也都是这个写法)。
 */
const ERROR_COPY: Record<UpdateFailureCode, string> = {
	// 唯一该弹红字的一条(见下面的 DANGEROUS_CODE):分发链上可能真的有人动过手脚。
	get untrusted() {
		return i18n.t("panelUi.components.update.update-section.3");
	},
	get malformed() {
		return i18n.t("panelUi.components.update.update-section.4");
	},
	get unreachable() {
		return i18n.t("panelUi.components.update.update-section.5");
	},
	get stale_manifest() {
		return i18n.t("panelUi.components.update.update-section.6");
	},
	get checksum_mismatch() {
		return i18n.t("panelUi.components.update.update-section.7");
	},
	get download_failed() {
		return i18n.t("panelUi.components.update.update-section.8");
	},
	get install_failed() {
		return i18n.t("panelUi.components.update.update-section.9");
	},
	get nothing_to_roll_back() {
		return i18n.t("panelUi.components.update.update-section.10");
	},
};

/** 唯一弹红字的一条。其余一律中性旁注 —— 把代理站抽风渲染成安全警告只会训练用户忽略它。 */
const DANGEROUS_CODE: UpdateFailureCode = "untrusted";

export interface UpdateSectionProps {
	/** 只给测试压短等待;正常挂载不传。 */
	restartWait?: RestartWait;
}

export function UpdateSection({ restartWait = DEFAULT_RESTART_WAIT }: UpdateSectionProps = {}) {
	const tx = useT();

	const qc = useQueryClient();
	// 按下重启之后的进度住在模块级 store 里(理由见 restart.ts):用户中途离开系统页,
	// 等待照样进行、换成了照样刷新;回来看到的还是同一份进度。
	const {
		view,
		begin: beginRestart,
		retry: retryRestart,
		dismiss: dismissRestart,
	} = useRestartStore();
	// 「重启一下」那一节按出来的等待归它自己显示 —— 这里只管更新 / 回退带来的那一次,
	// 否则同一份状态会被两节各画一遍,而且这一节的措辞讲的是「换到哪一版」。
	const restart = view?.intent.mode === "restart" ? null : view;
	const statusQuery = useUpdateStatus();
	const globalsQuery = useCoreSettings();

	const act = useMutation({
		mutationFn: (path: "check" | "download" | "rollback") =>
			api.post<UpdateStatusView>(`/api/system/update/${path}`, {}),
		// 上一次重启留下的旁注(回落了 / 没回来)到此为止 —— 用户已经在做别的事了。
		onMutate: () => dismissRestart(),
		onSuccess: (next) => qc.setQueryData(UPDATE_QUERY_KEY, next),
	});
	const apply = useMutation({
		// 回话里带着要换掉的是哪个进程(startedAt)、换到哪(target / mode):服务端握着状态,
		// 面板不必先探一次再猜。之后只有 startedAt 和它不同的回答才算新进程 —— 旧进程
		// 优雅停机时还能连上好几秒。
		mutationFn: () => api.post<UpdateApplyResponse>("/api/system/update/apply", {}),
		onMutate: () => dismissRestart(),
		onSuccess: ({ startedAt, target, mode }) =>
			beginRestart({ before: startedAt, target, mode }, restartWait),
	});
	const saveSettings = useMutation({
		mutationFn: (update: Partial<UpdateSettings>) => patchCoreSettings({ update }),
		onSuccess: () => qc.invalidateQueries({ queryKey: SETTINGS_KEY }),
	});

	const status = statusQuery.data;
	const settings = globalsQuery.data?.update;

	// 回落了:版本号与状态都得按现在真正跑着的那份来,别再显示「已就绪」。
	useEffect(() => {
		if (restart?.kind !== "fell-back") return;
		void qc.invalidateQueries({ queryKey: UPDATE_QUERY_KEY });
		void qc.invalidateQueries({ queryKey: HEALTH_QUERY_KEY });
	}, [restart, qc]);

	// 概览的「去更新」和右下角的通知卡都带着 #update 跳过来:滚到这一节。这一节前面还排着七八个
	// 各自异步的分区(系统设置 / 指令 / 链接解析 / 皮肤 / 备份 …),滚完还得跟一会儿 —— 为什么与
	// 怎么跟都在 `useScrollToHash` 里。这一节自己从骨架换成整张卡(`loaded`)时再补一次。
	const anchorRef = useRef<HTMLDivElement>(null);
	useScrollToHash(UPDATE_SECTION_HASH, anchorRef, Boolean(status && settings));

	if (!status || !settings) {
		return (
			<div ref={anchorRef} style={{ scrollMarginTop: BELOW_HEADER_TOP }}>
				<GlassBox
					title={tx("panelUi.components.update.update-section.11")}
					accent={SECTION_ACCENT.system}
					icon={<Icon.sparkle size={14} />}
				>
					<LoadingBlock variant="inset" label={tx("panelUi.components.update.update-section.12")} />
				</GlassBox>
			</div>
		);
	}

	const { state } = status;
	// 忙不忙看的是**任何一种**重启:进程都要没了,这一节的按钮全都不该还能按。
	const restarting = view?.kind === "waiting";
	const busy = act.isPending || apply.isPending || restarting;
	// 和服务端 `POST /api/system/update/apply` 那道门用的是同一个判定,见契约。
	const canApply = canApplyUpdate(state);
	// 带 releaseUrl 的那几档(有新版 / 正在下 / 已就绪 / 要重拉镜像)都指到那一版的发布页;
	// 出错时指到 helpUrl(拿不到清单就是发布列表)。往联合里再加一档带 releaseUrl 的
	// 状态不用回来改这里。
	const helpUrl =
		state.phase === "error" ? state.helpUrl : "releaseUrl" in state ? state.releaseUrl : undefined;

	return (
		<div ref={anchorRef} style={{ scrollMarginTop: BELOW_HEADER_TOP }}>
			<GlassBox
				title={tx("panelUi.components.update.update-section.13")}
				subtitle={tx("panelUi.components.update.update-section.14")}
				accent={SECTION_ACCENT.system}
				icon={<Icon.sparkle size={14} />}
				badge={status.currentVersion}
			>
				<div className="flex flex-col gap-4">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-bn-sm text-bn-text-secondary">{phaseLabel(status)}</span>
						{helpUrl ? (
							<a
								className="text-bn-sm text-bn-pink underline underline-offset-2"
								href={helpUrl}
								target="_blank"
								rel="noreferrer"
								onClick={externalLinkClick(helpUrl)}
							>
								{tx("panelUi.components.update.update-section.15")}
							</a>
						) : null}
					</div>

					{"notes" in state && state.notes ? (
						<p className="whitespace-pre-wrap text-bn-sm text-bn-text-secondary">{state.notes}</p>
					) : null}

					{state.phase === "disabled" ? (
						<HintNote tone="neutral">
							{state.reason === "dev-build"
								? tx("panelUi.components.update.update-section.16")
								: tx("panelUi.components.update.update-section.17")}
						</HintNote>
					) : null}

					{status.pinnedVersion !== null && state.phase !== "rolled-back" ? (
						<HintNote tone="neutral">
							{tx("panelUi.components.update.update-section.18", {
								version: status.pinnedVersion,
							})}
						</HintNote>
					) : null}

					{state.phase === "needs-image-pull" ? (
						<HintNote tone="neutral">{tx("panelUi.components.update.update-section.20")}</HintNote>
					) : null}

					{state.phase !== "error" ? null : state.code === DANGEROUS_CODE ? (
						<ErrorNote>{ERROR_COPY[state.code]}</ErrorNote>
					) : (
						<HintNote tone="neutral">{ERROR_COPY[state.code]}</HintNote>
					)}

					{canApply && !restarting ? (
						<HintNote tone="neutral">
							{tx("panelUi.components.update.update-section.21", { policy: "restart" })}
						</HintNote>
					) : null}

					{restart?.kind === "waiting" ? (
						<LoadingBlock
							variant="inset"
							label={tx("panelUi.components.update.update-section.25", {
								value0: restart.intent.target,
							})}
							hint={tx("panelUi.components.update.update-section.26")}
						/>
					) : null}

					{restart?.kind === "fell-back" ? (
						<HintNote tone="neutral">
							{tx("panelUi.components.update.update-section.27", {
								running: restart.version,
								target: restart.intent.target,
								prefix: "[boot]",
							})}
						</HintNote>
					) : null}

					{restart?.kind === "timed-out" ? (
						<HintNote tone="neutral" className="flex flex-wrap items-center gap-2">
							<span>
								{tx("panelUi.components.update.update-section.31", {
									count: Math.round(restartWait.timeoutMs / 1000),
									policy: "restart",
								})}
							</span>
							<Btn variant="outline" size="sm" onClick={retryRestart}>
								{tx("panelUi.components.update.update-section.34")}
							</Btn>
						</HintNote>
					) : null}

					{apply.isError ? (
						<HintNote tone="neutral">
							{tx("panelUi.components.update.update-section.35", {
								reason: apply.error.message,
							})}
						</HintNote>
					) : null}

					<div className="flex flex-wrap gap-2">
						<Btn
							variant="outline"
							size="sm"
							disabled={busy || state.phase === "disabled"}
							onClick={() => act.mutate("check")}
						>
							{tx("panelUi.components.update.update-section.36")}
						</Btn>
						{state.phase === "available" ? (
							<Btn
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => act.mutate("download")}
							>
								{tx("panelUi.components.update.update-section.37")}
							</Btn>
						) : null}
						{canApply ? (
							<Btn variant="primary" size="sm" disabled={busy} onClick={() => apply.mutate()}>
								{tx("panelUi.components.update.update-section.38")}
							</Btn>
						) : null}
						<Btn
							variant="danger-outline"
							size="sm"
							disabled={busy || status.rollbackTarget === null}
							onClick={() => act.mutate("rollback")}
						>
							{status.rollbackTarget
								? tx("panelUi.components.update.update-section.39", {
										value0: status.rollbackTarget,
									})
								: tx("panelUi.components.update.update-section.40")}
						</Btn>
					</div>

					<div className="flex flex-col gap-3 border-bn-border border-t pt-3">
						{/* 不用 <label>:里面是一组按钮 / 一颗开关,不是原生表单控件,
					    关联不上。无障碍名由 Picker 的按钮文字与 Toggle 的 ariaLabel 各自给。 */}
						<div className="flex flex-wrap items-center gap-3">
							<span className="w-24 text-bn-sm text-bn-text-secondary">
								{tx("panelUi.components.update.update-section.41")}
							</span>
							<Picker
								value={settings.channel}
								options={CHANNEL_OPTIONS}
								onChange={(channel) =>
									saveSettings.mutate({ channel: channel as UpdateSettings["channel"] })
								}
							/>
							<span className="text-bn-xs text-bn-text-tertiary">
								{tx("panelUi.components.update.update-section.42")}
							</span>
						</div>

						<div className="flex flex-wrap items-center gap-3">
							<span className="w-24 text-bn-sm text-bn-text-secondary">
								{tx("panelUi.components.update.update-section.43")}
							</span>
							<Toggle
								value={settings.autoDownload}
								ariaLabel={tx("panelUi.components.update.update-section.44")}
								onChange={(autoDownload) => saveSettings.mutate({ autoDownload })}
							/>
							<span className="text-bn-xs text-bn-text-tertiary">
								{tx("panelUi.components.update.update-section.45")}
								<strong>{tx("panelUi.components.update.update-section.46")}</strong>
							</span>
						</div>

						<MirrorPicker
							active={settings.mirrors[0] ?? ""}
							disabled={state.phase === "disabled"}
							onSelect={(prefix) => saveSettings.mutate({ mirrors: prefix ? [prefix] : [] })}
						/>
					</div>
				</div>
			</GlassBox>
		</div>
	);
}
