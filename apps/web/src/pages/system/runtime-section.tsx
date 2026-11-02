import type { SettingsResponse } from "@bilibili-notify/contract";
import { HISTORY_RETENTION_DAY_OPTIONS } from "@bilibili-notify/internal/history";
import { GlassBox, Icon, StatusDot, Toggle } from "@bilibili-notify/ui";
import { BrowserSourceSettings } from "../../components/browser-source-settings";
import {
	Field,
	LogLevelPicker,
	type LogLevelValue,
	Picker,
	TInput,
	TNum,
} from "../../components/forms";
import { AI_PURPLE } from "../../config/colors";
import { PUSH_TONE } from "../../config/push-features";
import { SECTION_ACCENT } from "../../config/section-accents";
import { BILIBILI_SOURCE_KEY } from "../../types/domain";
import type { LoggingSettings, LogLevel, SettingsPatch } from "../../types/globals";

/**
 * `logging.levels` 里的按模块覆盖 —— **四个模块全在这一格里设**。
 *
 * image / ai 从前各自躺在「图片渲染」与「智能女仆」页的底部:同一个键分三处编辑,
 * 要调日志得先猜它归哪一页,而那两页的存盘各自还得为这一个键单独带上 `logging` 这半片
 * 补丁。日志是运维口的东西,与那两页在管的「画成什么样 / 用哪家模型」不是一回事。
 */
const SYSTEM_MODULES: ReadonlyArray<{
	id: string;
	label: string;
	tone: string;
}> = [
	// B 站那一格管动态与直播两个引擎(它们共用日志等级表里的一个键),色用推送里直播那一族的 B 站粉,
	// 直接引家族色,不另抄一份。core 不属于任何一族,给它 System 这一屏自己的角光色。
	{ id: "core", label: "core 核心", tone: SECTION_ACCENT.system },
	{ id: BILIBILI_SOURCE_KEY, label: "bilibili B 站", tone: PUSH_TONE.live },
	// 后两格同理不新造色:image 借版式那一族的紫,ai 借它全站通用的 `AI_PURPLE`
	// —— 两抹紫差着一个色相档,并排看得出是两个模块。
	{ id: "image", label: "image 出图", tone: SECTION_ACCENT.message },
	{ id: "ai", label: "ai 女仆", tone: AI_PURPLE },
];

const LOG_LEVEL_NUM: Record<LogLevel, LogLevelValue> = { error: 1, warn: 2, info: 3, debug: 4 };
const NUM_TO_LOG: Record<LogLevelValue, LogLevel> = {
	1: "error",
	2: "warn",
	3: "info",
	4: "debug",
};

function SystemSettingsSection({
	draft,
	onPatch,
}: {
	draft: SettingsResponse;
	onPatch: (delta: SettingsPatch) => void;
}) {
	// 核心那几格在 `core` 下,B 站的两格在它自己的设置里、挂在 `bilibili` 键下(ADR-0021 决策 42 下 10-01 的 🔗);
	// 第 4 期起这一节按集成的描述画,B 站那半的形状随之删。
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

	// 只动 `logging.levels[id]` 这一个键,同格里别的模块不受影响(四个模块都在这一格里设)。
	// 退回「跟随全局」发显式 null —— 从前是「拷一份、删掉该键、整份回传」,而整份
	// 回传走合并,被删的键当场合回来:同时有两个以上模块覆盖时就删不掉了。
	function setModuleLevel(id: string, value: LogLevelValue | null): void {
		onPatch({
			core: { logging: { levels: { [id]: value === null ? null : NUM_TO_LOG[value] } } },
		});
	}

	return (
		<GlassBox
			title="Core · 应用"
			subtitle="后端运行参数"
			accent="var(--color-bn-pink)"
			icon={<Icon.sliders size={14} />}
			badge="core"
		>
			<Field code="bilibili.dynamicCron">
				<TInput value={source.dynamicCron} onChange={(v) => setSource("dynamicCron", v)} mono />
			</Field>

			<Field code="core.logging.level">
				<LogLevelPicker
					value={LOG_LEVEL_NUM[logging.level]}
					onChange={(v) => v != null && setLogging("level", NUM_TO_LOG[v])}
				/>
			</Field>

			<Field code="core.logging.levels" full>
				<div className="grid w-full grid-cols-1 gap-1.5 sm:grid-cols-3">
					{SYSTEM_MODULES.map((m) => {
						const current = logging.levels[m.id];
						return (
							<div
								key={m.id}
								className="flex items-center justify-between gap-2 rounded-md border border-bn-border-subtle bg-bn-surface/60 px-2.5 py-1.5"
							>
								<span className="flex items-center gap-1.5 text-bn-sm font-bold text-bn-text-primary">
									<StatusDot size="sm" color={m.tone} />
									{m.label}
								</span>
								<LogLevelPicker
									value={current ? LOG_LEVEL_NUM[current] : null}
									onChange={(v) => setModuleLevel(m.id, v)}
									allowInherit
								/>
							</div>
						);
					})}
				</div>
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
						label: `${days} 天`,
					}))}
				/>
			</Field>

			<Field code="core.logging.memoryLog.enabled">
				<Toggle
					value={logging.memoryLog.enabled}
					onChange={(v) => onPatch({ core: { logging: { memoryLog: { enabled: v } } } })}
					ariaLabel="内存自检打印"
				/>
			</Field>
		</GlassBox>
	);
}

/** 现有运行内容照搬；按集成日志与设置分别由4-34、4-44接入。 */
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
