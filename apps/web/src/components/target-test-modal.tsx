import type {
	ConnectionCapabilitiesMap,
	TargetReceptionTest,
	TargetTestResponse,
} from "@bilibili-notify/contract";
import { TARGET_TEST_KINDS, type TargetTestKind } from "@bilibili-notify/internal/push-target";
import {
	Btn,
	CheckRow,
	ErrorNote,
	HintNote,
	Icon,
	ModalShell,
	OptionCard,
	TriStateChip,
} from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { api } from "../services/api";
import type { Connection, PushTarget } from "../types/domain";
import { copyToClipboard } from "../utils/clipboard";
import { TargetLabel } from "./target-display";

/** 目标级测试：一次一项，发送与接收分开，所有结果留在发起操作的弹窗内。 */
export function TargetTestModal({
	target,
	connection,
	onCancel,
	onResult,
}: {
	target: PushTarget;
	connection: Connection | undefined;
	onCancel: () => void;
	onResult: () => void;
}) {
	const t = useT();
	const [kind, setKind] = useState<TargetTestKind>("text");
	const [confirmed, setConfirmed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<TargetTestResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [reception, setReception] = useState<TargetReceptionTest | null>(null);
	const [pollError, setPollError] = useState<string | null>(null);
	const [pollAttempt, setPollAttempt] = useState(0);
	const [copied, setCopied] = useState<boolean | null>(null);
	const current = useRef(0);
	const live = useRef(true);
	const session = useRef<string | null>(null);
	const resultCallback = useRef(onResult);
	resultCallback.current = onResult;
	const query = useQuery({
		queryKey: [
			"connection-capabilities",
			connection?.id,
			connection?.settings,
			connection?.enabled,
		],
		queryFn: () => api.get<ConnectionCapabilitiesMap>("/api/connections/capabilities"),
		staleTime: 30_000,
		retry: false,
		enabled: !!connection,
	});
	const caps = connection ? query.data?.[connection.id] : undefined;
	const labels: Record<TargetTestKind, string> = {
		text: t("targets.test.text"),
		atAll: t("targets.capabilities.atAll"),
		nativeShare: t("targets.capabilities.nativeShare"),
		image: t("targets.capabilities.image"),
		imageGroup: t("targets.capabilities.imageGroup"),
		forward: t("targets.capabilities.forward"),
		audio: t("targets.capabilities.audio"),
		markdown: t("targets.capabilities.markdown"),
		inbound: t("targets.capabilities.inbound"),
	};
	const supportOf = (value: TargetTestKind) => {
		if (value === "text") return { state: "supported" as const };
		if (value === "atAll" && (target.kind === "endpoint" || target.scope === "private"))
			return { state: "unsupported" as const, reason: t("targets.test.groupOnly") };
		if (value === "inbound" && (target.kind === "endpoint" || target.scope === "channel"))
			return { state: "unsupported" as const, reason: t("targets.test.inboundScope") };
		return caps?.[value] ?? { state: "unknown" as const };
	};
	const support = supportOf(kind);
	const inactive = !target.enabled || !connection?.enabled;
	const waiting = reception?.state === "pending";
	const cancelSession = useCallback(() => {
		const id = session.current;
		session.current = null;
		if (id) void api.delete(`/api/targets/${target.id}/test/${id}`).catch(() => undefined);
	}, [target.id]);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
			current.current += 1;
			cancelSession();
		};
	}, [cancelSession]);
	const waitingId = reception?.state === "pending" ? reception.id : null;
	useEffect(() => {
		if (!waitingId) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				const view = await api.get<TargetReceptionTest>(
					`/api/targets/${target.id}/test/${waitingId}`,
				);
				if (cancelled || session.current !== waitingId) return;
				setReception(view);
				setPollError(null);
				if (view.state === "pending") timer = setTimeout(poll, 1000);
			} catch (e) {
				if (!cancelled && session.current === waitingId)
					setPollError(e instanceof Error ? e.message : String(e));
			}
		};
		timer = setTimeout(poll, pollAttempt === 0 ? 1000 : 0);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [target.id, waitingId, pollAttempt]);
	function select(value: TargetTestKind) {
		current.current += 1;
		cancelSession();
		setReception(null);
		setResult(null);
		setError(null);
		setPollError(null);
		setPollAttempt(0);
		setCopied(null);
		setConfirmed(false);
		setKind(value);
	}
	async function send() {
		const generation = ++current.current;
		cancelSession();
		setReception(null);
		setResult(null);
		setError(null);
		setPollError(null);
		setPollAttempt(0);
		setCopied(null);
		setBusy(true);
		try {
			const response = await api.post<TargetTestResponse>(
				`/api/targets/${target.id}/test`,
				kind === "atAll" ? { capability: kind, confirmAtAll: confirmed } : { capability: kind },
			);
			if (!live.current || current.current !== generation) {
				if (response.ok && response.reception)
					void api
						.delete(`/api/targets/${target.id}/test/${response.reception.id}`)
						.catch(() => undefined);
				return;
			}
			setResult(response);
			if (response.ok && response.reception) {
				session.current = response.reception.id;
				setReception(response.reception);
			}
			resultCallback.current();
		} catch (e) {
			if (live.current && current.current === generation)
				setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (live.current && current.current === generation) setBusy(false);
		}
	}
	const statusLabels = {
		supported: t("targets.test.supported"),
		unsupported: t("targets.test.unsupported"),
		unknown: t("targets.test.unknown"),
	};
	const status = (state: "supported" | "unsupported" | "unknown") => statusLabels[state];
	const previews: Record<TargetTestKind, string> = {
		text: t("targets.test.preview.text"),
		atAll: t("targets.test.preview.atAll"),
		nativeShare: t("targets.test.preview.nativeShare"),
		image: t("targets.test.preview.image"),
		imageGroup: t("targets.test.preview.imageGroup"),
		forward: t("targets.test.preview.forward"),
		audio: t("targets.test.preview.audio"),
		markdown: t("targets.test.preview.markdown"),
		inbound: t("targets.test.preview.inbound"),
	};
	const receptionLabels = {
		pending: t("targets.test.reception.pending"),
		received: t("targets.test.reception.received"),
		expired: t("targets.test.reception.expired"),
		cancelled: t("targets.test.reception.cancelled"),
	};
	const actionText = busy
		? t("targets.test.sending")
		: waiting
			? t("targets.test.waiting")
			: kind === "inbound"
				? t("targets.test.startReception")
				: t("targets.test.send");

	return (
		<ModalShell
			width={600}
			onCancel={onCancel}
			title={t("targets.test.title")}
			description={
				<div className="flex flex-wrap items-center justify-between gap-3">
					<TargetLabel target={target} connections={connection ? [connection] : []} />
					<span className="text-bn-xs text-bn-text-tertiary">{t("targets.test.oneAtATime")}</span>
				</div>
			}
		>
			<fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
				<legend className="mb-2 text-bn-sm font-semibold text-bn-text-secondary">
					{t("targets.test.choose")}
				</legend>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
					{TARGET_TEST_KINDS.map((value) => (
						<OptionCard
							key={value}
							active={kind === value}
							label={labels[value]}
							description={status(supportOf(value).state)}
							onSelect={() => select(value)}
						/>
					))}
				</div>
			</fieldset>
			<section
				className="mt-4 rounded-xl border border-bn-border bg-bn-surface-muted/60 p-4"
				aria-label={t("targets.test.preview")}
			>
				<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
					<h3 className="text-bn-sm font-semibold text-bn-text-secondary">
						{t("targets.test.preview")}
					</h3>
					<TriStateChip label={status(support.state)} state={support.state} />
				</div>
				{kind === "image" || kind === "imageGroup" || kind === "forward" ? (
					<div className="mb-3 flex gap-2" aria-hidden="true">
						{(kind === "image" ? [1] : [1, 2]).map((n) => (
							<span
								key={n}
								className={`flex h-16 w-24 items-center justify-center gap-2 rounded-lg text-bn-base font-bold text-bn-on-solid ${n === 1 ? "bg-bn-pink" : "bg-bn-blue"}`}
							>
								<Icon.image size={20} />
								BN · {n}
							</span>
						))}
					</div>
				) : kind === "audio" ? (
					<div className="mb-3 flex items-center gap-3 text-bn-pink">
						<Icon.mic size={24} />
						<span className="text-bn-base font-semibold">{t("targets.test.audioSample")}</span>
					</div>
				) : null}
				<p className="whitespace-pre-wrap break-words text-bn-base leading-relaxed text-bn-text-primary">
					{previews[kind]}
				</p>
				{support.reason ? (
					<p className="mt-2 text-bn-xs leading-relaxed text-bn-text-secondary">{support.reason}</p>
				) : null}
				{support.state === "unknown" ? (
					<p className="mt-2 text-bn-xs text-bn-text-tertiary">{t("targets.test.unknownHint")}</p>
				) : null}
			</section>
			{kind === "atAll" ? (
				<div className="mt-3">
					<CheckRow checked={confirmed} onChange={setConfirmed}>
						{t("targets.test.confirmAtAll")}
					</CheckRow>
				</div>
			) : null}
			{inactive ? (
				<div className="mt-3">
					<HintNote>{t("targets.test.inactive")}</HintNote>
				</div>
			) : null}
			<div className="mt-3 space-y-2" role="status" aria-live="polite">
				{busy ? <HintNote>{t("targets.test.sending")}</HintNote> : null}
				{error ? <ErrorNote>{error}</ErrorNote> : null}
				{result && !result.ok ? (
					result.code === "indeterminate" ? (
						<HintNote>
							{t("targets.test.indeterminate")} {result.message}
						</HintNote>
					) : (
						<ErrorNote>{result.message}</ErrorNote>
					)
				) : null}
				{result?.ok && !reception ? (
					<div
						className={`rounded-lg px-3 py-2 text-bn-sm ${result.isSynthetic ? "bg-bn-surface-muted text-bn-text-secondary" : "bg-bn-success-soft text-bn-success-text"}`}
					>
						<p className="font-semibold">
							{result.isSynthetic
								? t("targets.test.synthetic")
								: t("targets.test.accepted", { ms: result.latencyMs })}
						</p>
						<p className="mt-1 text-bn-xs">{t("targets.test.verifyInChat")}</p>
					</div>
				) : null}
				{reception ? (
					<div className="rounded-lg border border-bn-border bg-bn-surface p-3">
						<p className="text-bn-base font-semibold">{receptionLabels[reception.state]}</p>
						{reception.state === "pending" ? (
							<>
								<p className="mt-1 text-bn-xs leading-relaxed text-bn-text-secondary">
									{t("targets.test.replyHint")}
								</p>
								<div className="mt-3 flex flex-wrap items-center gap-2">
									<code className="break-all text-bn-base font-semibold tracking-wide">
										{reception.reply}
									</code>
									<Btn
										size="sm"
										variant="outline"
										onClick={() => void copyToClipboard(reception.reply).then(setCopied)}
									>
										<Icon.copy size={14} />
										{copied ? t("targets.test.copied") : t("targets.test.copy")}
									</Btn>
								</div>
								{copied === false ? (
									<p className="mt-1 text-bn-xs text-bn-text-secondary">
										{t("targets.test.copyFailed")}
									</p>
								) : null}
							</>
						) : null}
					</div>
				) : null}
				{pollError ? (
					<HintNote>
						{pollError}
						<Btn
							size="sm"
							variant="outline"
							onClick={() => {
								setPollError(null);
								setPollAttempt((value) => value + 1);
							}}
						>
							{t("targets.test.retryRead")}
						</Btn>
					</HintNote>
				) : null}
			</div>
			<div className="mt-5 flex items-center justify-end gap-2 border-t border-bn-border/60 pt-4">
				<Btn variant="outline" onClick={onCancel}>
					{waiting ? t("targets.test.stopWaiting") : t("targets.test.close")}
				</Btn>
				<Btn
					variant="primary"
					disabled={
						busy ||
						waiting ||
						inactive ||
						support.state === "unsupported" ||
						(kind === "atAll" && !confirmed)
					}
					onClick={() => void send()}
				>
					{actionText}
				</Btn>
			</div>
		</ModalShell>
	);
}
