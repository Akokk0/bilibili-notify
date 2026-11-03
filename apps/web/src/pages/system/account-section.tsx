import type { SettingsResponse } from "@bilibili-notify/contract";
import { BILIBILI_SOURCE_KEY } from "@bilibili-notify/contract";
import { Avatar, Btn, ErrorNote, GlassBox, Icon, ModalShell, QrPanel } from "@bilibili-notify/ui";
import { useState } from "react";
import { AUTH_STATUS_ACCENT, AUTH_STATUS_LABELS, authMessageOf } from "../../config/auth-status";
import { useSourceAuth } from "../../hooks/use-source-auth";
import { useT } from "../../i18n";
import { ApiError } from "../../services/api";
import { errorTextOf } from "../../services/error-text";
import type { Connection, PushTarget } from "../../types/domain";
import type { GlobalConfigPatch } from "../../types/globals";
import { imageUrl } from "../../utils/image-url";
import { MasterSection } from "./master-section";

/**
 * 单一状态表达:状态由 GlassBox 的 `accent`(随态变色)+ `badge`
 * (`AUTH_STATUS_LABELS` 文案,GlassBox 原生渲染成 Pill)承载。服务端给的 `message`
 * (失败 / 失效原因、`confirming` 要主人做什么)只在卡片正文里写一遍,不拼进标签。
 * 状态还没取到(查询在路上)时没有 `AuthState` 可查表,用下面这组占位。
 */
const LOADING_ACCENT = "var(--color-bn-blue)";

function QrCard({ dataUrl }: { dataUrl: string }) {
	const tx = useT();

	return (
		// data-tour:「带我做」导览的聚光灯锚点 —— 二维码一出现聚光灯就从登录按钮转移过来
		<QrPanel
			data-tour="bili-login-qr"
			src={dataUrl}
			alt={tx("panelUi.pages.system.account-section.1")}
			loading={tx("panelUi.pages.system.account-section.2")}
		>
			<div className="text-bn-sm text-bn-text-secondary">
				{tx("panelUi.pages.system.account-section.3")}
			</div>
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

/** 始终挂载以保留扫码/关闭状态，分区切换只控制可见内容。账号中立化归4-40。 */
export function AccountSection({
	active,
	draft,
	targets,
	connections,
	onPatch,
}: {
	active: boolean;
	draft: SettingsResponse | null;
	targets: PushTarget[];
	connections: Connection[];
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const tx = useT();

	const auth = useSourceAuth(BILIBILI_SOURCE_KEY);
	const [actionError, setActionError] = useState<string | null>(null);
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

	// 登录 / 退出的错误显示在账号卡的红框里;成功的结果由 `useSourceAuth` 写回查询缓存。
	const startQr = auth.startLogin;
	const logout = auth.logout;
	function reportActionError(err: unknown): void {
		setActionError(err instanceof ApiError ? err.message : String(err));
	}

	const accent = authState ? AUTH_STATUS_ACCENT[authState.status] : LOADING_ACCENT;
	const badge = authState
		? AUTH_STATUS_LABELS[authState.status]
		: tx("panelUi.pages.system.account-section.4");
	// 等待扫码时按钮是「继续扫码」(重开弹窗,不重新发起)。
	const resumable = authState?.status === "awaiting-scan";
	// 卡片正文:扫码弹窗开着时整块不写(状态与进度都在弹窗里)。`expired` / `error` 的话在下面的红框里。
	let bodyText: string | null = null;
	if (!authState) bodyText = auth.isError ? null : tx("panelUi.pages.system.account-section.5");
	else if (authState.status === "logged-out") {
		bodyText = tx("panelUi.pages.system.account-section.6");
	} else if (authState.status === "confirming" && !qrModalOpen) {
		bodyText = authMessageOf(authState) || tx("panelUi.pages.system.account-section.7");
	}
	const modalBody =
		authState?.status === "awaiting-scan" ? (
			<QrCard dataUrl={authState.qr.dataUrl} />
		) : authState?.status === "confirming" ? (
			<ConfirmingCard
				message={authMessageOf(authState) || tx("panelUi.pages.system.account-section.8")}
			/>
		) : null;

	if (!active) return null;
	return (
		<>
			<GlassBox
				title={tx("panelUi.pages.system.account-section.9")}
				subtitle={tx("panelUi.pages.system.account-section.10")}
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
								{accountName ?? tx("panelUi.pages.system.account-section.11")}
							</div>
							<div className="mt-0.5 text-bn-xs text-bn-text-secondary">
								{tx("panelUi.pages.system.account-section.12")}
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
						{tx("panelUi.pages.system.account-section.13")}
						{errorTextOf(auth.error)}
					</ErrorNote>
				) : null}
				{actionError ? (
					<ErrorNote className="mt-2.5">
						{tx("panelUi.pages.system.account-section.14")}
						{actionError}
					</ErrorNote>
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
						{startQr.isPending
							? tx("panelUi.pages.system.account-section.15")
							: resumable
								? tx("panelUi.pages.system.account-section.16")
								: tx("panelUi.pages.system.account-section.17")}
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
						{logout.isPending
							? tx("panelUi.pages.system.account-section.18")
							: tx("panelUi.pages.system.account-section.19")}
					</Btn>
				</div>
			</GlassBox>

			{/* 二维码弹窗:不撑开页面布局;导览聚光灯经 bili-login-qr 锚点转移到这里 */}
			{qrModalOpen && modalBody ? (
				<ModalShell
					onCancel={() => setQrDismissed(true)}
					width={360}
					title={tx("panelUi.pages.system.account-section.20")}
				>
					{modalBody}
				</ModalShell>
			) : null}

			{draft ? (
				<MasterSection
					draft={draft.core}
					targets={targets}
					connections={connections}
					onPatch={onPatch}
				/>
			) : null}

			<details className="rounded-sm border border-bn-border bg-bn-surface-muted p-3 text-bn-sm text-bn-text-secondary">
				<summary className="cursor-pointer font-medium text-bn-text-primary">
					{tx("panelUi.pages.system.account-section.21")}
				</summary>
				<pre className="mt-2 overflow-auto leading-relaxed">
					{JSON.stringify(
						auth.raw ?? { hint: tx("panelUi.pages.system.account-section.22") },
						null,
						2,
					)}
				</pre>
			</details>
		</>
	);
}
