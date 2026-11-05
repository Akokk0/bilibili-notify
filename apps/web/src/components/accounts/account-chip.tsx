import {
	Btn,
	ErrorNote,
	Icon,
	LoadingBlock,
	MenuItem,
	PopoverShell,
	useDismiss,
} from "@bilibili-notify/ui";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AUTH_STATUS_LABELS } from "../../config/auth-status";
import { useAccounts } from "../../hooks/useAccounts";
import { useSources } from "../../hooks/useSources";
import { useT } from "../../i18n";
import { errorTextOf } from "../../services/error-text";
import { AccountFace, accountPath, accountSourceLabel } from "./account-face";

export function AccountChip() {
	const tx = useT();
	const query = useAccounts();
	const sources = useSources();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const wrap = useRef<HTMLDivElement>(null);
	const anchor = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	useDismiss(wrap, () => setOpen(false), {
		enabled: open,
		event: "pointerdown",
		escape: true,
		insideRefs: [panel],
	});
	useEffect(() => {
		if (open) panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
	}, [open]);
	const rows = query.data?.accounts ?? [];
	const first = rows[0];
	const source = first ? sources.data?.sources?.find((s) => s.key === first.sourceKey) : undefined;
	if (query.isSuccess && rows.length === 0) return <span>{tx("problems.greeting")}</span>;
	const name = query.isError
		? tx("accounts.readFailedTitle")
		: !first
			? tx("accounts.loading")
			: first.state.status === "logged-in"
				? first.account?.name || accountSourceLabel(first.sourceKey, sources.data?.sources)
				: `${accountSourceLabel(first.sourceKey, sources.data?.sources)} · ${AUTH_STATUS_LABELS[first.state.status]}`;
	function go(key?: string) {
		setOpen(false);
		navigate(accountPath(key));
	}
	return (
		<div ref={wrap} className="relative min-w-0">
			<button
				ref={anchor}
				type="button"
				data-bn="btn"
				className="bn-account-trigger"
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={tx("accounts.trigger", { name })}
				title={name}
				onClick={() => setOpen(!open)}
			>
				{!query.isError && first?.state.status === "logged-in" ? (
					<span className="shrink-0">{tx("accounts.current")}</span>
				) : null}
				<span className="bn-account-trigger-name">{name}</span>
				<AccountFace account={query.isError ? undefined : first} source={source} size={20} />
				<span className="shrink-0 rotate-90">
					<Icon.chevronRight size={10} />
				</span>
			</button>
			{open ? (
				<PopoverShell
					anchorRef={anchor}
					preferredWidth={300}
					maxPanelHeight={400}
					onAnchorHidden={() => setOpen(false)}
					layer="overlay"
					surface="solid-strong"
				>
					<div
						ref={panel}
						role="menu"
						aria-label={tx("accounts.title")}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								setOpen(false);
								anchor.current?.focus();
								return;
							}
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								const buttons = [
									...(panel.current?.querySelectorAll<HTMLButtonElement>(
										"button:not([disabled])",
									) ?? []),
								];
								const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
								buttons[
									(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length
								]?.focus();
							}
						}}
					>
						<div className="px-3 py-2 text-bn-xs text-bn-text-tertiary">
							{tx("accounts.menuHint")}
						</div>
						{query.isError ? (
							<div className="px-3 pb-3">
								<ErrorNote size="sm">
									{errorTextOf(query.error)}
									<div className="mt-2">
										<Btn size="sm" variant="outline" onClick={() => void query.refetch()}>
											{tx("accounts.retry")}
										</Btn>
									</div>
								</ErrorNote>
							</div>
						) : !first ? (
							<LoadingBlock variant="inset" label={tx("accounts.loading")} />
						) : (
							rows.map((account, index) => {
								const label = accountSourceLabel(account.sourceKey, sources.data?.sources);
								const entry = sources.data?.sources?.find((s) => s.key === account.sourceKey);
								return (
									<MenuItem
										role="menuitem"
										key={account.sourceKey}
										ariaLabel={tx("accounts.view", { source: label })}
										onClick={() => go(account.sourceKey)}
										icon={<AccountFace account={account} source={entry} size={28} />}
									>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-bn-sm font-medium">
												{account.state.status === "logged-in"
													? account.account?.name || label
													: label}
											</span>
											<span className="block text-bn-xs text-bn-text-tertiary">
												{label} · {AUTH_STATUS_LABELS[account.state.status]}
												{index === 0 ? ` · ${tx("accounts.headerShown")}` : ""}
											</span>
										</span>
										<Icon.chevronRight size={12} />
									</MenuItem>
								);
							})
						)}
						<div className="mt-1 border-t border-bn-border-subtle pt-1">
							<MenuItem role="menuitem" icon={<Icon.sliders size={14} />} onClick={() => go()}>
								{tx("accounts.manage")}
							</MenuItem>
						</div>
					</div>
				</PopoverShell>
			) : null}
		</div>
	);
}
