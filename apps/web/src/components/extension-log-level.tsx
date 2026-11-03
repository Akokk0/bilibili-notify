import type { SettingsResponse } from "@bilibili-notify/contract";
import { Btn, ErrorNote, LoadingBlock } from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patchCoreSettings, SETTINGS_KEY, useCoreSettings } from "../hooks/useSettings";
import { useT } from "../i18n";
import { errorTextOf } from "../services/error-text";
import type { LogLevel } from "../types/globals";
import { LogLevelSetting } from "./log-level-setting";

/** 拓展自己的日志等级属于宿主设置；不读写拓展声明式设置。 */
export function ExtensionLogLevel({ id, name }: { id: string; name: string }) {
	const t = useT();
	const query = useCoreSettings();
	const qc = useQueryClient();
	const save = useMutation({
		mutationFn: (level: LogLevel | null) =>
			patchCoreSettings({ logging: { levels: { [id]: level } } }),
		onSuccess: (saved: SettingsResponse) => qc.setQueryData(SETTINGS_KEY, saved),
	});
	const logging = query.data?.logging;
	if (query.isError || (!query.isPending && !logging))
		return (
			<ErrorNote>
				<div>{t("logging.readFailed")}</div>
				<Btn
					aria-label={t("logging.retryRead")}
					size="sm"
					variant="outline"
					onClick={() => {
						void query.refetch();
					}}
				>
					{t("logging.retry")}
				</Btn>
			</ErrorNote>
		);
	if (!logging) return <LoadingBlock variant="inset" label={t("logging.readLoading")} />;
	return (
		<div className="min-w-0 space-y-2">
			<LogLevelSetting
				id={id}
				name={name}
				value={Object.hasOwn(logging.levels, id) ? logging.levels[id] : undefined}
				disabled={save.isPending}
				onChange={(level) => save.mutate(level)}
			/>
			<p className="text-bn-xs text-bn-text-secondary">{t("logging.extensionHint")}</p>
			{save.isError ? (
				<ErrorNote>{t("logging.saveFailed", { reason: errorTextOf(save.error) })}</ErrorNote>
			) : null}
		</div>
	);
}
