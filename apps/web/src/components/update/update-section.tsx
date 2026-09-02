import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import type { UpdateSettings } from "@bilibili-notify/internal";
import {
	Btn,
	ErrorNote,
	GlassBox,
	HintNote,
	Icon,
	LoadingBlock,
	Picker,
	Toggle,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { SECTION_ACCENT } from "../../config/section-accents";
import { api } from "../../services/api";
import type { GlobalConfig } from "../../types/globals";
import { MirrorPicker } from "./mirror-picker";
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
	{ value: "stable", label: "正式版" },
	{ value: "prerelease", label: "预发布" },
];

/** 报错文案。措辞按归因分三档,别混成一句「更新失败」。 */
function errorCopy(reason: string): { text: string; danger: boolean } {
	switch (reason) {
		case "untrusted":
			// 唯一该弹红字的一条:分发链上可能真的有人动过手脚。
			return {
				text: "更新包的签名验不过 —— 拿到的东西不是我们签发的。已停下,什么都没装。如果你填了加速前缀,先把它去掉再试一次;还是这样就先别更新。",
				danger: true,
			};
		case "malformed":
			return {
				text: "更新清单读不出来 —— 这是我们发版时出的岔子,不是你的问题。过阵子再试。",
				danger: false,
			};
		case "unreachable":
			return {
				text: "连不上更新服务器。可以在下面填一个加速前缀,或者按链接自己去下载。",
				danger: false,
			};
		case "stale-manifest":
			return {
				text: "拿到的更新清单比之前见过的旧,没有收。多半是加速站缓存了旧文件 —— 换个站、或改回直连再试。",
				danger: false,
			};
		case "checksum-mismatch":
			return {
				text: "下下来的包对不上校验和,已丢弃、盘上没留东西。多半是中途被截断了,重试一次。",
				danger: false,
			};
		case "download-failed":
			return {
				text: "清单拿到了,包没下下来。可以换个加速前缀,或者按链接自己去下载。",
				danger: false,
			};
		case "install-failed":
			return {
				text: "包是好的,写进数据目录时失败了 —— 先看看磁盘还有没有空间、目录是不是只读。",
				danger: false,
			};
		case "nothing-to-roll-back":
			return { text: "已经是最早的那一版了,没有可退的上一版。", danger: false };
		default:
			return { text: "这次没成。", danger: false };
	}
}

export function UpdateSection() {
	const qc = useQueryClient();
	const statusQuery = useUpdateStatus();
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});

	const act = useMutation({
		mutationFn: (path: "check" | "download" | "rollback") =>
			api.post<UpdateStatusDTO>(`/api/update/${path}`, {}),
		onSuccess: (next) => qc.setQueryData(UPDATE_QUERY_KEY, next),
	});
	const apply = useMutation({
		mutationFn: () => api.post("/api/update/apply", {}),
	});
	const saveSettings = useMutation({
		mutationFn: (update: Partial<UpdateSettings>) => api.patch("/api/globals", { update }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	const status = statusQuery.data;
	const settings = globalsQuery.data?.update;

	// 概览的「去更新」和右下角的通知卡都带着 #update 跳过来:滚到这一节。数据到齐后
	// 再滚一次 —— 上面几节是异步撑开的,第一次滚的位置多半已经被顶下去了。
	const location = useLocation();
	const anchorRef = useRef<HTMLDivElement>(null);
	const loaded = Boolean(status && settings);
	// biome-ignore lint/correctness/useExhaustiveDependencies: location.key 与 loaded 是刻意的重触发条件 —— 再点一次「去更新」(同 hash)与数据到齐各要再滚一次
	useEffect(() => {
		if (location.hash !== UPDATE_SECTION_HASH) return;
		anchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
	}, [location.key, location.hash, loaded]);

	if (!status || !settings) {
		return (
			<div ref={anchorRef} className="scroll-mt-4">
				<GlassBox
					title="应用内更新 · update"
					accent={SECTION_ACCENT.system}
					icon={<Icon.sparkle size={14} />}
				>
					<LoadingBlock variant="inset" label="正在读取更新状态…" />
				</GlassBox>
			</div>
		);
	}

	const { state } = status;
	const busy = act.isPending || apply.isPending;
	const canApply = state.phase === "ready" || state.phase === "rolled-back";
	const helpUrl =
		state.phase === "error"
			? state.helpUrl
			: state.phase === "available" || state.phase === "ready" || state.phase === "downloading"
				? state.releaseUrl
				: state.phase === "needs-image-pull"
					? state.releaseUrl
					: undefined;

	return (
		<div ref={anchorRef} className="scroll-mt-4">
			<GlassBox
				title="应用内更新 · update"
				subtitle="在这里直接换版本,不用重新拉镜像或下载安装包"
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
							>
								打开发布页
							</a>
						) : null}
					</div>

					{"notes" in state && state.notes ? (
						<p className="whitespace-pre-wrap text-bn-sm text-bn-text-secondary">{state.notes}</p>
					) : null}

					{state.phase === "disabled" ? (
						<HintNote tone="neutral">
							这个构建里没有内置更新签名的公钥,所以应用内更新是关着的 —— 不是出错。自己
							构建的版本会落在这一档,按原来的方式升级即可。
						</HintNote>
					) : null}

					{status.pinnedVersion !== null && state.phase !== "rolled-back" ? (
						<HintNote tone="neutral">
							现在钉在 <strong>{status.pinnedVersion}</strong>
							(之前按过回退),打开面板不会再自动查更新。 按「检查更新」就是明确要往前走 ——
							装上新版会拔掉这颗钉子。
						</HintNote>
					) : null}

					{state.phase === "needs-image-pull" ? (
						<HintNote tone="neutral">
							这一版要求更新的运行环境(Node / 浏览器都来自镜像),没法在线换 —— 请重新
							拉取镜像或下载新安装包。
						</HintNote>
					) : null}

					{state.phase === "error"
						? (() => {
								const copy = errorCopy(state.reason);
								return copy.danger ? (
									<ErrorNote>{copy.text}</ErrorNote>
								) : (
									<HintNote tone="neutral">{copy.text}</HintNote>
								);
							})()
						: null}

					{canApply ? (
						<HintNote tone="neutral">
							应用会<strong>重启服务</strong>:那一刻推送会断几秒、直播监听会重连。容器部署请确认{" "}
							<code>restart</code> 策略是开着的 ——
							没有它的话,进程退出后不会有人把它拉起来;桌面版由外壳自动拉起,界面会跟着刷新。
						</HintNote>
					) : null}

					<div className="flex flex-wrap gap-2">
						<Btn
							variant="outline"
							size="sm"
							disabled={busy || state.phase === "disabled"}
							onClick={() => act.mutate("check")}
						>
							检查更新
						</Btn>
						{state.phase === "available" ? (
							<Btn
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => act.mutate("download")}
							>
								下载这一版
							</Btn>
						) : null}
						{canApply ? (
							<Btn variant="primary" size="sm" disabled={busy} onClick={() => apply.mutate()}>
								立即重启并应用
							</Btn>
						) : null}
						<Btn
							variant="danger-outline"
							size="sm"
							disabled={busy || status.rollbackTarget === null}
							onClick={() => act.mutate("rollback")}
						>
							{status.rollbackTarget ? `退回 ${status.rollbackTarget}` : "没有可退的版本"}
						</Btn>
					</div>

					<div className="flex flex-col gap-3 border-bn-border border-t pt-3">
						{/* 不用 <label>:里面是一组按钮 / 一颗开关,不是原生表单控件,
					    关联不上。无障碍名由 Picker 的按钮文字与 Toggle 的 ariaLabel 各自给。 */}
						<div className="flex flex-wrap items-center gap-3">
							<span className="w-24 text-bn-sm text-bn-text-secondary">更新渠道</span>
							<Picker
								value={settings.channel}
								options={CHANNEL_OPTIONS}
								onChange={(channel) =>
									saveSettings.mutate({ channel: channel as UpdateSettings["channel"] })
								}
							/>
							<span className="text-bn-xs text-bn-text-tertiary">
								预发布版没验够,出问题的概率明显更高
							</span>
						</div>

						<div className="flex flex-wrap items-center gap-3">
							<span className="w-24 text-bn-sm text-bn-text-secondary">自动下载</span>
							<Toggle
								value={settings.autoDownload}
								ariaLabel="自动下载新版本"
								onChange={(autoDownload) => saveSettings.mutate({ autoDownload })}
							/>
							<span className="text-bn-xs text-bn-text-tertiary">
								只下载;<strong>什么时候重启换版本永远由你按</strong>
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
