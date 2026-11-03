import type { SettingsResponse } from "@bilibili-notify/contract";
import { HISTORY_RETENTION_DAY_OPTIONS } from "@bilibili-notify/internal/history";
import { GlassBox, Icon, Toggle } from "@bilibili-notify/ui";
import { BrowserSourceSettings } from "../../components/browser-source-settings";
import { Field, Picker, TInput, TNum } from "../../components/forms";
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
	// 核心那几格在 `core` 下,B 站的两格在它自己的设置里、挂在 `bilibili` 键下(ADR-0021 决策 42 下 10-01 的 🔗);
	// 第 4 期起这一节按集成的描述画,B 站那半的形状随之删。
	const t = useT();
	const logging = draft.core.logging;
	const source = draft.bilibili as {
		dynamicCron: string;
		healthCheckMinutes: number;
	};

	const setLogging = <K extends keyof LoggingSettings>(key: K, v: LoggingSettings[K]) => {
		onPatch({ core: { logging: { [key]: v } as Partial<LoggingSettings> } });
	};
	const setSource = <K extends keyof typeof source>(key: K, v: (typeof source)[K]) => {
		onPatch({ bilibili: { [key]: v } });
	};

	return (
		<GlassBox
			title={t("logging.runtimeTitle")}
			subtitle={t("logging.runtimeSubtitle")}
			accent="var(--color-bn-pink)"
			icon={<Icon.sliders size={14} />}
			badge="core"
		>
			<Field code="bilibili.dynamicCron">
				<TInput value={source.dynamicCron} onChange={(v) => setSource("dynamicCron", v)} mono />
			</Field>

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

			<Field code="bilibili.healthCheckMinutes">
				<TNum
					value={source.healthCheckMinutes}
					onChange={(v) => setSource("healthCheckMinutes", v)}
					min={1}
					max={1440}
					suffix="min"
				/>
			</Field>

			{/* 只许七档:选项个数固定,用段选钮组,不用下拉。 */}
			<Field code="core.history.retentionDays">
				<Picker
					value={draft.core.history.retentionDays}
					onChange={(v) => onPatch({ core: { history: { retentionDays: v } } })}
					options={HISTORY_RETENTION_DAY_OPTIONS.map((days) => ({
						value: days,
						label: t("logging.retentionDays", { count: days }),
					}))}
				/>
			</Field>

			<Field code="core.logging.memoryLog.enabled">
				<Toggle
					value={logging.memoryLog.enabled}
					onChange={(v) => onPatch({ core: { logging: { memoryLog: { enabled: v } } } })}
					ariaLabel={t("logging.memoryLog")}
				/>
			</Field>
		</GlassBox>
	);
}

/** 日志归属已接入；B站设置仍随4-44移到独立分区。 */
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
