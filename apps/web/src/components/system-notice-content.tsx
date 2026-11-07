import type {
	MarketplaceEntryView,
	ReleaseNoteEntry,
	RestartAbility,
	SystemNotice,
} from "@bilibili-notify/contract";
import { Btn, ErrorNote, HintNote, LoadingBlock, WarnNote } from "@bilibili-notify/ui";
import { lazy, Suspense } from "react";
import { useExtensions } from "../hooks/useExtensions";
import { useT } from "../i18n";
import { errorTextOf } from "../services/error-text";
import { openExternal } from "../utils/externalLink";
import { safeHref } from "../utils/safe-href";
import { NoticeExtensionList } from "./system-notice-extensions";
import { UNTRUSTED_MARKDOWN_COMPONENTS } from "./untrusted-markdown";

const ReactMarkdown = lazy(() => import("react-markdown"));
function releaseHref(value: string) {
	try {
		new URL(value);
		return safeHref(value);
	} catch {
		return undefined;
	}
}

function ReleaseNotes({ releases }: { releases: ReleaseNoteEntry[] }) {
	const tx = useT();
	return releases.length === 0 ? (
		<HintNote className="mt-4">{tx("lifecycle.noReleaseNotes")}</HintNote>
	) : (
		<div className="mt-4 space-y-4">
			{releases.map((release) => {
				const href = releaseHref(release.releaseUrl);
				return (
					<section key={release.version} className="border-t border-bn-border-subtle pt-3">
						<h2 className="text-bn-sm font-bold text-bn-text-primary">
							{release.version}
							{release.date ? ` · ${release.date}` : ""}
						</h2>
						<Suspense
							fallback={<LoadingBlock variant="inset" label={tx("lifecycle.loadingNotes")} />}
						>
							<div className="break-words [&_h1]:text-bn-base [&_h2]:text-bn-sm [&_h3]:text-bn-sm [&_p]:text-bn-sm [&_ul]:text-bn-sm [&_ol]:text-bn-sm">
								<ReactMarkdown components={UNTRUSTED_MARKDOWN_COMPONENTS}>
									{release.summary}
								</ReactMarkdown>
							</div>
							{release.caution ? (
								<WarnNote size="sm" className="mt-3">
									<div className="break-words [&_h1]:text-bn-base [&_h2]:text-bn-sm [&_p]:text-bn-sm">
										<ReactMarkdown components={UNTRUSTED_MARKDOWN_COMPONENTS}>
											{release.caution}
										</ReactMarkdown>
									</div>
								</WarnNote>
							) : null}
						</Suspense>
						{href ? (
							<div className="mt-3">
								<Btn size="sm" variant="outline" onClick={() => openExternal(href)}>
									{tx("lifecycle.fullNotes")}
								</Btn>
							</div>
						) : null}
					</section>
				);
			})}
		</div>
	);
}

export function SystemNoticeContent({
	notice,
	runningVersion,
	onNavigate,
	onFresh,
	onUpdate,
	disabled,
}: {
	notice: SystemNotice;
	runningVersion: string;
	onNavigate: (to: string) => void;
	onFresh: () => void;
	onUpdate: (entry: MarketplaceEntryView, sourceName: string) => void;
	disabled: boolean;
}) {
	const tx = useT();
	if (notice.kind === "updated")
		return (
			<>
				<p>{tx("lifecycle.updatedHint", { version: notice.version })}</p>
				<ReleaseNotes releases={notice.releases} />
			</>
		);
	if (notice.kind === "generation-failed")
		return (
			<>
				<p>
					{notice.source === "zero" ? tx("lifecycle.remigrateFailed") : tx("lifecycle.emptyFailed")}
				</p>
				<ErrorNote size="sm" className="mt-4">
					<span className="break-all">{notice.message}</span>
				</ErrorNote>
				<HintNote className="mt-4">{tx("lifecycle.fixGeneration")}</HintNote>
				<div className="mt-3">
					<Btn
						size="sm"
						variant="outline"
						disabled={disabled}
						onClick={() => onNavigate("/system#storage")}
					>
						{tx("lifecycle.viewStorage")}
					</Btn>
				</div>
			</>
		);
	if (notice.kind === "rolled-back")
		return (
			<>
				<p>{tx("lifecycle.rollbackHint", { failed: notice.version, current: runningVersion })}</p>
				<WarnNote size="sm" className="mt-4">
					{tx("lifecycle.separateData")}
				</WarnNote>
				<p className="mt-3 text-bn-xs">{tx("lifecycle.noAutomaticRetry")}</p>
				<div className="mt-3">
					<Btn size="sm" variant="outline" disabled={disabled} onClick={() => onNavigate("/logs")}>
						{tx("lifecycle.viewLogs")}
					</Btn>
				</div>
			</>
		);
	return (
		<MigratedContent
			notice={notice}
			onNavigate={onNavigate}
			onFresh={onFresh}
			onUpdate={onUpdate}
			disabled={disabled}
		/>
	);
}

function MigratedContent({
	notice,
	onNavigate,
	onFresh,
	onUpdate,
	disabled,
}: {
	notice: Extract<SystemNotice, { kind: "migrated" }>;
	onNavigate: (to: string) => void;
	onFresh: () => void;
	onUpdate: (entry: MarketplaceEntryView, sourceName: string) => void;
	disabled: boolean;
}) {
	const tx = useT();
	const extensions = useExtensions({ retry: false });
	const incompatible =
		extensions.data?.extensions.filter((ext) => ext.state === "incompatible") ?? [];
	return (
		<>
			<p className="mb-4">{tx("lifecycle.migrationHint")}</p>
			<div className="divide-y divide-bn-border-subtle">
				{notice.cardSkinsDropped ? (
					<div className="py-3">
						<h2 className="text-bn-sm font-bold text-bn-text-primary">
							{tx("lifecycle.skinsTitle")}
						</h2>
						<p>{tx("lifecycle.skinsHint")}</p>
						<div className="mt-2">
							<Btn
								size="sm"
								variant="outline"
								disabled={disabled}
								onClick={() => onNavigate("/cards")}
							>
								{tx("lifecycle.openCards")}
							</Btn>
						</div>
					</div>
				) : null}
				{notice.masterTargetCleared ? (
					<div className="py-3">
						<h2 className="text-bn-sm font-bold text-bn-text-primary">
							{tx("lifecycle.masterTitle")}
						</h2>
						<p>{tx("lifecycle.masterHint")}</p>
						<div className="mt-2">
							<Btn
								size="sm"
								variant="outline"
								disabled={disabled}
								onClick={() => onNavigate("/system#account")}
							>
								{tx("lifecycle.openMaster")}
							</Btn>
						</div>
					</div>
				) : null}
				{extensions.isPending ? (
					<LoadingBlock variant="inset" label={tx("lifecycle.loadingExtensions")} />
				) : extensions.isError ? (
					<ErrorNote size="sm">
						{tx("lifecycle.extensionsFailed")}
						<p className="my-2 break-all">{errorTextOf(extensions.error)}</p>
						<Btn size="sm" variant="outline" onClick={() => void extensions.refetch()}>
							{tx("lifecycle.retry")}
						</Btn>
					</ErrorNote>
				) : incompatible.length > 0 ? (
					<NoticeExtensionList
						extensions={incompatible}
						disabled={disabled}
						onNavigate={onNavigate}
						onUpdate={onUpdate}
					/>
				) : null}
			</div>
			<details className="mt-3">
				<summary className="cursor-pointer text-bn-sm font-bold text-bn-text-primary">
					{tx("lifecycle.overview", { version: notice.version })}
				</summary>
				<ReleaseNotes releases={notice.releases} />
			</details>
			<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
				<span className="text-bn-xs">{tx("lifecycle.freshQuestion")}</span>
				<Btn size="sm" variant="danger-outline" disabled={disabled} onClick={onFresh}>
					{tx("lifecycle.fresh")}
				</Btn>
			</div>
		</>
	);
}

export function FreshStartContent({
	ability,
	pending,
	error,
	onRetry,
}: {
	ability?: RestartAbility;
	pending: boolean;
	error: unknown;
	onRetry: () => void;
}) {
	const tx = useT();
	return (
		<>
			<WarnNote size="sm">{tx("lifecycle.emptyConsequences")}</WarnNote>
			<p className="mt-4">{tx("lifecycle.reconfigure")}</p>
			<p className="mt-3">{tx("lifecycle.keepPanelLogin")}</p>
			{ability?.can && ability.how === "container" ? (
				<HintNote className="mt-4">{tx("lifecycle.containerRestart")}</HintNote>
			) : null}
			{pending ? (
				<LoadingBlock variant="inset" label={tx("lifecycle.loadingAbility")} />
			) : error ? (
				<ErrorNote size="sm" className="mt-4">
					{errorTextOf(error)}
					<Btn size="sm" variant="outline" onClick={onRetry}>
						{tx("lifecycle.retry")}
					</Btn>
				</ErrorNote>
			) : ability?.can === false ? (
				<ErrorNote size="sm" className="mt-4">
					{ability.message}
				</ErrorNote>
			) : !ability ? (
				<ErrorNote size="sm" className="mt-4">
					{tx("lifecycle.abilityUnknown")}
					<Btn size="sm" variant="outline" onClick={onRetry}>
						{tx("lifecycle.retry")}
					</Btn>
				</ErrorNote>
			) : null}
		</>
	);
}
