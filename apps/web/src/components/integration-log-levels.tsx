import { Btn, ErrorNote, LoadingBlock } from "@bilibili-notify/ui";
import { useAdapters } from "../hooks/useAdapters";
import { useExtensions } from "../hooks/useExtensions";
import { useSources } from "../hooks/useSources";
import { useT } from "../i18n";
import type { LogLevel, ModuleLogLevels } from "../types/globals";
import { LogLevelSetting } from "./log-level-setting";

/** 核心三格与宿主提供的集成名单取并集；未识别覆盖键仍可查看和清除。 */
export function IntegrationLogLevels({
	levels,
	onChange,
}: {
	levels: ModuleLogLevels;
	onChange: (key: string, level: LogLevel | null) => void;
}) {
	const t = useT();
	const sources = useSources();
	const adapters = useAdapters();
	const extensions = useExtensions();
	const installed = extensions.data?.extensions ?? [];
	const extensionIds = new Set(installed.map((item) => item.id));
	const names = new Map<string, string>([
		["core", t("logging.core")],
		["image", t("logging.image")],
		["ai", t("logging.ai")],
	]);
	for (const source of sources.data?.sources ?? [])
		if (!extensionIds.has(source.key) && !names.has(source.key))
			names.set(source.key, source.descriptor.label);
	for (const adapter of adapters.data?.adapters ?? [])
		if (!extensionIds.has(adapter.key) && !names.has(adapter.key))
			names.set(adapter.key, adapter.descriptor.label);
	for (const ext of installed) names.set(ext.id, ext.name || ext.id);
	const known = new Set(names.keys());
	for (const key of Object.keys(levels)) if (!names.has(key)) names.set(key, key);
	const failed = sources.isError || adapters.isError || extensions.isError;
	const loading = sources.isPending || adapters.isPending || extensions.isPending;
	return (
		<div className="grid w-full min-w-0 gap-2">
			{failed ? (
				<ErrorNote>
					<div>{t("logging.ownersFailed")}</div>
					<Btn
						aria-label={t("logging.retryOwners")}
						size="sm"
						variant="outline"
						onClick={() => {
							void sources.refetch();
							void adapters.refetch();
							void extensions.refetch();
						}}
					>
						{t("logging.retry")}
					</Btn>
				</ErrorNote>
			) : loading ? (
				<LoadingBlock variant="inset" label={t("logging.ownersLoading")} />
			) : null}
			{[...names].map(([id, name]) => (
				<LogLevelSetting
					key={id}
					id={id}
					name={name}
					value={Object.hasOwn(levels, id) ? levels[id] : undefined}
					unidentified={!known.has(id)}
					onChange={(level) => onChange(id, level)}
				/>
			))}
		</div>
	);
}
