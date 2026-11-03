import type { LogLevel } from "@bilibili-notify/contract";
import { useT } from "../i18n";
import { LogLevelPicker, type LogLevelValue } from "./forms";

const NUM: Record<LogLevel, LogLevelValue> = { error: 1, warn: 2, info: 3, debug: 4 };
const LEVEL: Record<LogLevelValue, LogLevel> = { 1: "error", 2: "warn", 3: "info", 4: "debug" };

/** 保留既有段选控件，日志键与数值档位只在这里转换。 */
export function LogLevelControl({
	value,
	onChange,
	allowInherit = false,
}: {
	value: LogLevel | undefined;
	onChange: (level: LogLevel | null) => void;
	allowInherit?: boolean;
}) {
	return (
		<LogLevelPicker
			value={value ? NUM[value] : null}
			allowInherit={allowInherit}
			onChange={(next) => onChange(next === null ? null : LEVEL[next])}
		/>
	);
}

/** 一个真实日志归属键的编辑行，不从运行状态推断等级。 */
export function LogLevelSetting({
	id,
	name,
	value,
	onChange,
	disabled = false,
	unidentified = false,
}: {
	id: string;
	name: string;
	value: LogLevel | undefined;
	onChange: (level: LogLevel | null) => void;
	disabled?: boolean;
	unidentified?: boolean;
}) {
	const t = useT();
	return (
		<fieldset
			data-code={`core.logging.levels.${id}`}
			aria-label={t("logging.ownerLabel", { name, id })}
			disabled={disabled}
			className="min-w-0 rounded-md border border-bn-border-subtle bg-bn-surface/60 px-2.5 py-2"
		>
			<div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
				<div className="min-w-0">
					<div className="break-words text-bn-sm font-bold text-bn-text-primary">{name}</div>
					{name !== id ? (
						<div className="break-all font-mono text-bn-2xs text-bn-text-tertiary">{id}</div>
					) : null}
				</div>
				<LogLevelControl
					value={value}
					allowInherit
					onChange={(next) => {
						if (!disabled) onChange(next);
					}}
				/>
			</div>
			{unidentified ? (
				<p className="mt-1 text-bn-xs text-bn-text-secondary">{t("logging.unidentified")}</p>
			) : null}
		</fieldset>
	);
}
