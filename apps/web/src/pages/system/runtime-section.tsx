import type { SettingsResponse } from "@bilibili-notify/contract";
import { GlassBox, Icon, Toggle } from "@bilibili-notify/ui";
import { BrowserSourceSettings } from "../../components/browser-source-settings";
import { Field } from "../../components/forms";
import { IntegrationLogLevels } from "../../components/integration-log-levels";
import { LogLevelControl } from "../../components/log-level-setting";
import { useT } from "../../i18n";
import type { LoggingSettings, SettingsPatch } from "../../types/globals";

function SystemSettingsSection({
	draft,
	onPatch,
}: {
	draft: SettingsResponse;
	onPatch: (delta: SettingsPatch) => void;
}) {
	const t = useT();
	const logging = draft.core.logging;

	const setLogging = <K extends keyof LoggingSettings>(key: K, v: LoggingSettings[K]) => {
		onPatch({ core: { logging: { [key]: v } as Partial<LoggingSettings> } });
	};
	return (
		<GlassBox
			title={t("logging.runtimeTitle")}
			subtitle={t("logging.runtimeSubtitle")}
			accent="var(--color-bn-pink)"
			icon={<Icon.sliders size={14} />}
			badge="core"
		>
			<Field code="core.logging.level">
				<LogLevelControl
					value={logging.level}
					onChange={(level) => {
						if (level) setLogging("level", level);
					}}
				/>
			</Field>

			<Field
				code="core.logging.levels"
				label={t("logging.overrides")}
				hint={t("logging.overridesHint")}
				full
			>
				<IntegrationLogLevels
					levels={logging.levels}
					onChange={(key, level) => onPatch({ core: { logging: { levels: { [key]: level } } } })}
				/>
			</Field>

			<Field code="core.logging.memoryLog.enabled">
				<Toggle
					value={logging.memoryLog.enabled}
					onChange={(v) => onPatch({ core: { logging: { memoryLog: { enabled: v } } } })}
					ariaLabel={t("logging.memoryLog")}
				/>
			</Field>
			<Field code="core.stats.enabled">
				<Toggle
					value={draft.core.stats.enabled}
					onChange={(enabled) => onPatch({ core: { stats: { enabled } } })}
					ariaLabel={t("statsSwitch.label")}
				/>
			</Field>
		</GlassBox>
	);
}

/** 核心运行参数和渲染浏览器；来源设置由独立描述驱动分区承载。 */
export function RuntimeSection({
	draft,
	onPatch,
}: {
	draft: SettingsResponse | null;
	onPatch: (delta: SettingsPatch) => void;
}) {
	return (
		<>
			{draft ? <SystemSettingsSection draft={draft} onPatch={onPatch} /> : null}
			<BrowserSourceSettings />
		</>
	);
}
