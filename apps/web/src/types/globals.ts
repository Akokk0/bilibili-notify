/**
 * GlobalConfig 域类型门面(原「手维护镜像」,已退役)—— 单一来源在
 * `@bilibili-notify/internal`,这里只做 `import type` re-export(编译后全擦除,
 * web 运行时仍是纯 JSON 消费者)。本文件自留的只剩 UI 侧派生别名与 PATCH 工具类型。
 */

import type { AISettings, GlobalConfig, ModuleLogLevels } from "@bilibili-notify/internal";

export type {
	AIPersona,
	AISettings,
	AppConfig,
	CardKind,
	CardStyle,
	CardStyleByKind,
	ContentFilters,
	FeatureFlags,
	GlobalConfig,
	GlobalDefaults,
	GuardBundle,
	GuardEntry,
	GuardLevel,
	ImageGroupSettings,
	LogLevel,
	MasterConfig,
	ModuleLogLevels,
	ScheduleConfig,
	TemplateBundle,
	TimeRange,
} from "@bilibili-notify/internal";

/** 引擎模块名(= ModuleLogLevels 的键集;internal 未单独导出该联合)。 */
export type ModuleName = keyof NonNullable<ModuleLogLevels>;

/** AI preset 单项(internal 里内联在 AISettings.presets,未单独导出)。 */
export type AIPreset = AISettings["presets"][number];

/** Patch payload for /api/globals — deeply partial; server merges + revalidates. */
type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type GlobalConfigPatch = DeepPartial<GlobalConfig>;
