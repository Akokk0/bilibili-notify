import {
	Btn,
	EmptyNote,
	ErrorNote,
	GlassBox,
	HintNote,
	Icon,
	LoadingBlock,
	Picker,
} from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { TargetExceptions } from "../../components/target-exceptions";
import { AI_PURPLE } from "../../config/colors";
import { useT } from "../../i18n";
import { api } from "../../services/api";
import type { Connection, PushTarget } from "../../types/domain";
import type { AiSettingsDraft } from "../../types/globals";

type Writing = AiSettingsDraft["writing"];
type Scene = keyof Writing;

/** Value updates remain in the AI page's single draft; inherit removes an override. */
export function WritingSettings({
	ai,
	onChange,
}: {
	ai: AiSettingsDraft;
	onChange: (writing: Writing) => void;
}) {
	const tx = useT();
	const [scene, setScene] = useState<Scene>("post");
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const connectionsQuery = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
	});
	const entry = ai.writing[scene];
	const targets = targetsQuery.data ?? [];
	const connections = connectionsQuery.data ?? [];
	const failed = targetsQuery.isError || connectionsQuery.isError;
	const loading = targetsQuery.isPending || connectionsQuery.isPending;
	const ready = !failed && !loading;
	const overrides = ready ? targets.filter((t) => entry.byTarget[t.id] !== undefined).length : 0;
	const missing = ready
		? Object.keys(entry.byTarget).filter((id) => !targets.some((t) => t.id === id)).length
		: 0;
	const choice = entry.isOnByDefault ? tx("aiWriting.ai") : tx("aiWriting.template");
	const options = [
		{ value: true, label: tx("aiWriting.ai"), color: AI_PURPLE },
		{ value: false, label: tx("aiWriting.template"), color: AI_PURPLE },
	];
	const setOverride = (id: string, value: boolean | "inherit") => {
		const byTarget = { ...entry.byTarget };
		if (value === "inherit") delete byTarget[id];
		else byTarget[id] = value;
		onChange({ ...ai.writing, [scene]: { ...entry, byTarget } });
	};
	return (
		<section aria-label={tx("aiWriting.title")}>
			<GlassBox
				title={tx("aiWriting.title")}
				subtitle={tx("aiWriting.subtitle")}
				accent={AI_PURPLE}
				icon={<Icon.feather size={14} />}
			>
				<fieldset aria-label={tx("aiWriting.scene")} className="m-0 min-w-0 border-0 p-0">
					<Picker<Scene>
						value={scene}
						onChange={setScene}
						options={[
							{ value: "post", label: tx("aiWriting.post"), color: AI_PURPLE },
							{ value: "liveSummary", label: tx("aiWriting.liveSummary"), color: AI_PURPLE },
						]}
					/>
				</fieldset>
				<p className="mt-3 text-bn-xs leading-snug text-bn-text-secondary">
					{scene === "post" ? tx("aiWriting.postHint") : tx("aiWriting.liveHint")}
				</p>
				{!ai.enabled ? <HintNote className="mt-4">{tx("aiWriting.off")}</HintNote> : null}
				<fieldset
					aria-label={tx("aiWriting.default")}
					data-code={`ai.writing.${scene}.isOnByDefault`}
					className="my-5 flex min-w-0 flex-wrap items-center justify-between gap-4 border-0 p-0"
				>
					<div>
						<div className="text-bn-sm font-semibold text-bn-text-primary">
							{tx("aiWriting.default")}
						</div>
						<p className="text-bn-xs leading-snug text-bn-text-secondary">
							{tx("aiWriting.defaultHint")}
						</p>
					</div>
					<Picker
						value={entry.isOnByDefault}
						onChange={(value) =>
							onChange({ ...ai.writing, [scene]: { ...entry, isOnByDefault: value } })
						}
						options={options}
					/>
				</fieldset>
				{failed ? (
					<ErrorNote>
						{tx("aiWriting.failed")}
						<Btn
							size="sm"
							variant="outline"
							onClick={() => {
								void targetsQuery.refetch();
								void connectionsQuery.refetch();
							}}
						>
							{tx("aiWriting.retry")}
						</Btn>
					</ErrorNote>
				) : loading ? (
					<LoadingBlock variant="inset" label={tx("aiWriting.loading")} />
				) : targets.length === 0 ? (
					<EmptyNote size="sm">{tx("aiWriting.empty")}</EmptyNote>
				) : (
					<div data-code={`ai.writing.${scene}.byTarget`}>
						<TargetExceptions
							targets={targets}
							connections={connections}
							color={AI_PURPLE}
							expandLabel={tx("aiWriting.expand")}
							collapseLabel={tx("aiWriting.collapse")}
							summary={
								<>
									<div className="text-bn-sm font-semibold text-bn-text-primary">
										{tx("aiWriting.exceptions")}
									</div>
									<p>
										{tx("aiWriting.targets", { count: targets.length })} ·{" "}
										{tx("aiWriting.overrides", { count: overrides })}
									</p>
								</>
							}
							renderCells={(target) => (
								<div data-code={`ai.writing.${scene}.byTarget.${target.id}`}>
									<Picker<boolean | "inherit">
										value={entry.byTarget[target.id] ?? "inherit"}
										onChange={(value) => setOverride(target.id, value)}
										options={[
											{
												value: "inherit",
												label: tx("aiWriting.inherit", { value: choice }),
												color: AI_PURPLE,
											},
											...options,
										]}
									/>
								</div>
							)}
						/>
					</div>
				)}
				{missing > 0 ? (
					<HintNote className="mt-4">{tx("aiWriting.orphan", { count: missing })}</HintNote>
				) : null}
			</GlassBox>
		</section>
	);
}
