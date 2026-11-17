import type { ConnectionView, DestinationStatusResponse } from "@bilibili-notify/contract";
import { Btn, HintNote, Icon, StatusDot } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { useT } from "../i18n";
import { api } from "../services/api";
import { errorTextOf } from "../services/error-text";
import type { PushTarget } from "../types/domain";

export function DestinationStatusPanel({
	target,
	connection,
	canQuery,
}: {
	target: PushTarget;
	connection: ConnectionView | undefined;
	canQuery: boolean;
}) {
	const t = useT();
	const name = target.name || (target.kind === "session" ? target.address : target.id);
	const force = useRef(false);
	const enabled =
		target.enabled && !!connection?.enabled && !connection.settingsIssues?.length && canQuery;
	const query = useQuery({
		queryKey: [
			"target-status",
			target.id,
			target.kind === "session" ? [target.address, target.parentAddress] : null,
			connection?.id,
			connection?.settings,
			enabled,
		],
		queryFn: () => {
			const suffix = force.current ? "?refresh=1" : "";
			force.current = false;
			return api.get<DestinationStatusResponse>(`/api/targets/${target.id}/status${suffix}`);
		},
		enabled,
		retry: false,
		staleTime: 30_000,
		refetchInterval: 60_000,
	});
	const role = query.data?.status?.role;
	const usage = query.data?.status?.atAllUsage;
	const roleLabel =
		role?.state !== "known"
			? t("targets.status.unknown")
			: role.value === "owner"
				? t("targets.status.owner")
				: role.value === "admin"
					? t("targets.status.admin")
					: t("targets.status.member");
	const usageLabel =
		usage?.state === "used"
			? query.isError
				? t("targets.status.recordedUse")
				: t("targets.status.used")
			: usage?.state === "exhausted"
				? t("targets.status.exhausted")
				: usage?.state === "indeterminate"
					? t("targets.status.indeterminate")
					: query.isError
						? t("targets.status.noRecordedUse")
						: t("targets.status.notRecorded");
	return (
		<section
			aria-label={t("targets.status.region", { name })}
			className="my-3 rounded-bn-sm bg-bn-code-bg/60 px-3 py-2.5"
		>
			<div className="mb-2 flex items-center justify-between gap-2">
				<h4 className="text-bn-xs font-semibold text-bn-text-secondary">
					{t("targets.status.title")}
				</h4>
				<Btn
					size="sm"
					variant="ghost"
					icon={<Icon.refresh size={12} />}
					disabled={!enabled || query.isFetching}
					aria-label={t("targets.status.refreshFor", { name })}
					onClick={() => {
						force.current = true;
						void query.refetch();
					}}
				>
					{query.isFetching ? t("targets.status.refreshing") : t("targets.status.refresh")}
				</Btn>
			</div>
			<dl className="grid min-h-10 grid-cols-2 gap-x-4 gap-y-2 text-bn-xs">
				<div>
					<dt className="mb-1 text-bn-text-tertiary">
						{query.isError && role?.state === "known"
							? t("targets.status.lastConfirmed")
							: t("targets.status.role")}
					</dt>
					<dd
						className="m-0 flex items-center gap-1.5 font-semibold text-bn-text-primary"
						title={role?.state === "known" ? role.checkedAt : role?.reason}
					>
						<StatusDot kind={role?.state === "known" ? "ok" : "pending"} size="sm" />
						{roleLabel}
					</dd>
				</div>
				{usage ? (
					<div>
						<dt className="mb-1 text-bn-text-tertiary">
							{query.isError
								? t("targets.status.lastUsage", { date: usage.date })
								: t("targets.status.atAllUsage")}
						</dt>
						<dd className="m-0 font-semibold text-bn-text-primary">{usageLabel}</dd>
					</div>
				) : null}
			</dl>
			{usage ? (
				<p className="mb-0 mt-2 text-bn-2xs leading-relaxed text-bn-text-tertiary">
					{t("targets.status.usageHint")}
				</p>
			) : null}
			{!enabled ? (
				<p className="mb-0 mt-2 text-bn-2xs text-bn-text-tertiary">
					{!target.enabled || !connection?.enabled
						? t("targets.status.disabled")
						: t("targets.status.unavailable")}
				</p>
			) : null}
			{role?.state === "unknown" && role.reason ? (
				<p className="mb-0 mt-2 text-bn-2xs text-bn-text-tertiary">{role.reason}</p>
			) : null}
			{query.isError ? (
				<HintNote className="mt-2">
					{t("targets.status.readFailed")}：{errorTextOf(query.error)}
				</HintNote>
			) : null}
		</section>
	);
}
