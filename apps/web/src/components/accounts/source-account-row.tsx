import type { AccountView, SourceEntry } from "@bilibili-notify/contract";
import {
	Btn,
	ErrorNote,
	Icon,
	IconButton,
	ModalShell,
	Pill,
	QrPanel,
	StatusDot,
} from "@bilibili-notify/ui";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import { AUTH_STATUS_ACCENT, AUTH_STATUS_LABELS, authMessageOf } from "../../config/auth-status";
import { useSourceAuth } from "../../hooks/use-source-auth";
import { useT } from "../../i18n";
import { errorTextOf } from "../../services/error-text";
import { DragHandle } from "../drag-handle";

import { AccountFace, AccountSourceIcon, accountRowId } from "./account-face";

export interface ScanSession {
	scanning: boolean;
	dismissed: boolean;
}
export function SourceAccountRow({
	account,
	source,
	total,
	first,
	tour,
	session,
	onDismiss,
}: {
	account: AccountView;
	source?: SourceEntry;
	total: number;
	first: boolean;
	tour: boolean;
	session: ScanSession;
	onDismiss: (dismissed: boolean) => void;
}) {
	const tx = useT();
	const label = source?.descriptor.label ?? account.sourceKey;
	const auth = useSourceAuth(account.sourceKey, { enabled: false });
	const [error, setError] = useState<string | null>(null);
	const state = account.state;
	const loggedIn = state.status === "logged-in";
	const busy = auth.startLogin.isPending || auth.logout.isPending;
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: account.sourceKey, disabled: total < 2 || busy });
	const open = session.scanning && !session.dismissed;
	const message = authMessageOf(state);
	return (
		<div
			ref={setNodeRef}
			id={accountRowId(account.sourceKey)}
			className="bn-source-account-row"
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				opacity: isDragging ? 0.7 : 1,
				zIndex: isDragging ? 1 : undefined,
			}}
		>
			<span className={`bn-source-account-handle ${total < 2 ? "invisible" : ""}`}>
				<DragHandle
					attributes={attributes}
					listeners={listeners}
					setActivatorNodeRef={setActivatorNodeRef}
					label={label}
				/>
			</span>
			<AccountFace account={account} source={source} />
			<div className="min-w-0">
				<div className="break-words text-bn-sm font-semibold text-bn-text-primary">
					{loggedIn ? account.account?.name || tx("accounts.loggedInFallback") : label}
					{first ? (
						<span className="ml-2 inline-block align-middle">
							<Pill color="var(--color-bn-pink)" size="sm" subtle>
								{tx("accounts.headerShown")}
							</Pill>
						</span>
					) : null}
				</div>
				<div className="mt-0.5 flex flex-wrap items-center gap-1 text-bn-xs text-bn-text-secondary">
					{source ? <AccountSourceIcon source={source} size={12} /> : null}
					{label}
				</div>
				<div
					className="mt-0.5 flex items-center gap-1 text-bn-xs"
					style={{ color: AUTH_STATUS_ACCENT[state.status] }}
				>
					<StatusDot color={AUTH_STATUS_ACCENT[state.status]} size="sm" />
					{AUTH_STATUS_LABELS[state.status]}
				</div>
				{state.status === "logged-out" ? (
					<p className="mt-1 text-bn-xs text-bn-text-secondary">
						{tx("accounts.loggedOutHint", { source: label })}
					</p>
				) : state.status === "confirming" && !open ? (
					<p className="mt-1 text-bn-xs text-bn-text-secondary">
						{message || AUTH_STATUS_LABELS.confirming}
					</p>
				) : null}
				{(state.status === "expired" || state.status === "error") && !open ? (
					<ErrorNote size="sm" className="mt-2">
						{message}
					</ErrorNote>
				) : null}
				{error ? (
					<ErrorNote size="sm" className="mt-2">
						{error}
					</ErrorNote>
				) : null}
			</div>
			<div className="bn-source-account-actions">
				<Btn
					size="sm"
					variant={loggedIn ? "outline" : "primary"}
					disabled={busy || loggedIn}
					aria-label={
						state.status === "awaiting-scan"
							? tx("accounts.continueLabel", { source: label })
							: tx("accounts.loginLabel", { source: label })
					}
					data-tour={tour ? "source-login" : undefined}
					onClick={() => {
						setError(null);
						if (state.status === "awaiting-scan" || session.scanning) onDismiss(false);
						else auth.startLogin.mutate(undefined, { onError: (e) => setError(errorTextOf(e)) });
					}}
				>
					{auth.startLogin.isPending
						? tx("accounts.working")
						: state.status === "awaiting-scan"
							? tx("accounts.continueScan")
							: tx("accounts.scanLogin")}
				</Btn>
				<IconButton
					size="lg"
					icon={<Icon.logout size={14} />}
					label={tx("accounts.logout", { source: label })}
					disabled={busy}
					onClick={() => {
						setError(null);
						auth.logout.mutate(undefined, { onError: (e) => setError(errorTextOf(e)) });
					}}
				/>
			</div>
			{open && (state.status === "awaiting-scan" || state.status === "confirming") ? (
				<ModalShell
					title={tx("accounts.scanTitle", { source: label })}
					width={360}
					onCancel={() => onDismiss(true)}
				>
					<div data-tour={tour ? "source-login-qr" : undefined}>
						{state.status === "awaiting-scan" ? (
							<QrPanel
								src={state.qr.dataUrl}
								alt={tx("accounts.qrAlt", { source: label })}
								loading={tx("accounts.loadingQr")}
							>
								<p className="text-bn-sm text-bn-text-secondary">
									{tx("accounts.scanHint", { source: label })}
								</p>
							</QrPanel>
						) : (
							<p className="py-4 text-center text-bn-sm text-bn-text-secondary">
								{message || tx("accounts.confirmPhone")}
							</p>
						)}
					</div>
				</ModalShell>
			) : null}
		</div>
	);
}
