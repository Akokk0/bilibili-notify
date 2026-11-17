import type {
	CapabilitySupport,
	ConnectionCapabilities,
	ConnectionCapabilitiesMap,
	ConnectionView,
} from "@bilibili-notify/contract";
import { Btn, HintNote, TriStateChip, useTriStateTexts } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { useT } from "../i18n";
import { api } from "../services/api";

export function ConnectionCapabilitiesPanel({ connection }: { connection: ConnectionView }) {
	const t = useT();
	const texts = useTriStateTexts();
	const query = useQuery({
		queryKey: ["connection-capabilities", connection.id, connection.settings, connection.enabled],
		queryFn: () => api.get<ConnectionCapabilitiesMap>("/api/connections/capabilities"),
		staleTime: 30_000,
		retry: false,
	});
	const caps = query.data?.[connection.id];
	const items: Array<[keyof ConnectionCapabilities, string]> = [
		["atAll", t("targets.capabilities.atAll")],
		["nativeShare", t("targets.capabilities.nativeShare")],
		["image", t("targets.capabilities.image")],
		["imageGroup", t("targets.capabilities.imageGroup")],
		["forward", t("targets.capabilities.forward")],
		["audio", t("targets.capabilities.audio")],
		["markdown", t("targets.capabilities.markdown")],
		["inbound", t("targets.capabilities.inbound")],
	];
	return (
		<div className="mt-4 border-t border-bn-border/50 pt-3">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h3 className="text-bn-xs font-semibold text-bn-text-secondary">
					{t("targets.capabilities.title")}
				</h3>
				<div className="flex flex-wrap items-center gap-3" aria-hidden="true">
					<TriStateChip label={texts.supported} state="supported" />
					<TriStateChip label={texts.unsupported} state="unsupported" />
					<TriStateChip label={texts.unknown} state="unknown" />
				</div>
			</div>
			<ul
				aria-label={t("targets.capabilities.title")}
				aria-busy={query.isFetching}
				className="m-0 grid w-fit max-w-full list-none grid-cols-1 gap-2 p-0 @min-[18rem]/connection-header:grid-cols-2 @min-[35rem]/connection-header:grid-cols-4 @min-[70rem]/connection-header:grid-cols-8"
			>
				{items.map(([key, label]) => {
					const support: CapabilitySupport | undefined = caps?.[key];
					const state =
						support?.state === "supported" || support?.state === "unsupported"
							? support.state
							: "unknown";
					return (
						<li
							key={key}
							className="flex min-h-9 items-center rounded-bn-xs bg-bn-surface-muted/60 px-2.5 py-2"
							aria-label={`${label}：${texts[state]}`}
							aria-description={support && "reason" in support ? support.reason : undefined}
						>
							<TriStateChip
								label={label}
								state={state}
								description={support && "reason" in support ? support.reason : undefined}
							/>
						</li>
					);
				})}
			</ul>
			{query.isError ? (
				<HintNote className="mt-3">
					{t("targets.capabilities.readFailed")}{" "}
					<Btn
						size="sm"
						variant="ghost"
						onClick={() => void query.refetch()}
						disabled={query.isFetching}
					>
						{t("targets.status.refresh")}
					</Btn>
				</HintNote>
			) : null}
		</div>
	);
}
