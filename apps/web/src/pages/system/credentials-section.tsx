import { Btn, ErrorNote, GlassBox, HintNote, Icon, ModalShell } from "@bilibili-notify/ui";
import { useId, useState } from "react";
import { TInput } from "../../components/forms";
import { useT } from "../../i18n";
import { api } from "../../services/api";
import { errorTextOf } from "../../services/error-text";
import { useDraftStore } from "../../store/draft";
import { useSessionStore } from "../../store/session";
import { isDesktop } from "../../utils/externalLink";

/** 面板登录凭据不进入核心设置草稿；仅在修改弹窗里短暂持有。 */
export function CredentialsSection() {
	const t = useT();
	const allowed = useSessionStore((s) => s.hydrated && s.authRequired && s.authed);
	const [open, setOpen] = useState(false);
	const dirty = useDraftStore((s) => (s.current?.diff.length ?? 0) > 0);
	if (!allowed || isDesktop()) return null;
	return (
		<>
			<GlassBox
				title={t("credentials.title")}
				subtitle={t("credentials.hint")}
				icon={<Icon.user size={14} />}
			>
				<Btn variant="outline" disabled={dirty} onClick={() => setOpen(true)}>
					{t("credentials.open")}
				</Btn>
				{dirty ? <HintNote className="mt-3">{t("credentials.pendingDraft")}</HintNote> : null}
			</GlassBox>
			{open ? <CredentialsDialog onClose={() => setOpen(false)} /> : null}
		</>
	);
}

function CredentialsDialog({ onClose }: { onClose: () => void }) {
	const id = useId();
	const t = useT();
	const [current, setCurrent] = useState("");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const close = () => {
		if (!busy) onClose();
	};
	async function save() {
		if (busy) return;
		if ((useDraftStore.getState().current?.diff.length ?? 0) > 0) {
			setError(t("credentials.pendingDraft"));
			return;
		}
		if (!current || !username.trim() || !password || !confirmation) {
			setError(t("credentials.required"));
			return;
		}
		if (password !== confirmation) {
			setError(t("credentials.mismatch"));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.put("/api/session/credentials", {
				currentPassword: current,
				username: username.trim(),
				password,
			});
			setCurrent("");
			setUsername("");
			setPassword("");
			setConfirmation("");
			useSessionStore.getState().markLoggedOut();
		} catch (error) {
			setError(t("credentials.failed", { reason: errorTextOf(error) }));
		} finally {
			setBusy(false);
		}
	}
	return (
		<ModalShell
			title={t("credentials.open")}
			description={t("credentials.hint")}
			width={440}
			onCancel={close}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<fieldset disabled={busy} className="min-w-0 space-y-3">
					<label htmlFor={`${id}-current`} className="block space-y-1">
						<span className="text-bn-sm font-semibold text-bn-text-primary">
							{t("credentials.current")}
						</span>
						<TInput
							id={`${id}-current`}
							value={current}
							onChange={setCurrent}
							secret
							autoComplete="current-password"
							ariaLabel={t("credentials.current")}
						/>
					</label>
					<label htmlFor={`${id}-username`} className="block space-y-1">
						<span className="text-bn-sm font-semibold text-bn-text-primary">
							{t("credentials.username")}
						</span>
						<TInput
							id={`${id}-username`}
							value={username}
							onChange={setUsername}
							autoComplete="username"
							ariaLabel={t("credentials.username")}
						/>
					</label>
					<label htmlFor={`${id}-password`} className="block space-y-1">
						<span className="text-bn-sm font-semibold text-bn-text-primary">
							{t("credentials.password")}
						</span>
						<span className="block text-bn-xs text-bn-text-secondary">
							{t("credentials.passwordHint")}
						</span>
						<TInput
							id={`${id}-password`}
							value={password}
							onChange={setPassword}
							secret
							ariaLabel={t("credentials.password")}
						/>
					</label>
					<label htmlFor={`${id}-confirmation`} className="block space-y-1">
						<span className="text-bn-sm font-semibold text-bn-text-primary">
							{t("credentials.confirmation")}
						</span>
						<TInput
							id={`${id}-confirmation`}
							value={confirmation}
							onChange={setConfirmation}
							secret
							ariaLabel={t("credentials.confirmation")}
						/>
					</label>
					<div className="flex flex-wrap justify-end gap-2 pt-2">
						<Btn variant="ghost" onClick={close}>
							{t("credentials.cancel")}
						</Btn>
						<Btn type="submit">{busy ? t("credentials.saving") : t("credentials.save")}</Btn>
					</div>
				</fieldset>
				{error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}
			</form>
		</ModalShell>
	);
}
