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

/**
 * Patch payload for /api/globals — deeply partial; server merges + revalidates.
 *
 * 任意层级都可显式为 `null` = 删除该键(JSON Merge Patch 语义,同
 * `@bilibili-notify/internal/patch`)。缺席的键表示「不改」,所以清除一个可选字段
 * 只能靠 null,不能靠把键拿掉。
 */
type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T;
export type GlobalConfigPatch = DeepPartial<GlobalConfig>;
