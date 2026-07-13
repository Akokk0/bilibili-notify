/**
 * GlobalConfig 域类型门面(原「手维护镜像」,已退役)—— 单一来源在
 * `@bilibili-notify/internal`,这里只做 `import type` re-export(编译后全擦除,
 * web 运行时仍是纯 JSON 消费者)。本文件自留的只剩 UI 侧派生别名与 PATCH 工具类型。
 */

import type { GlobalConfig } from "@bilibili-notify/internal";

export type {
	AIPersona,
	AISettings,
	AppConfig,
	CardKind,
	CardStyle,
	CardStyleByKind,
	ContentFilters,
	GlobalConfig,
	GlobalDefaults,
	GuardBundle,
	GuardEntry,
	ImageGroupSettings,
	LogLevel,
	ModuleLogLevels,
	ScheduleConfig,
	TemplateBundle,
} from "@bilibili-notify/internal";

/** Patch payload for /api/globals — deeply partial; server merges + revalidates. */
type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type GlobalConfigPatch = DeepPartial<GlobalConfig>;
