/**
 * GlobalConfig 域类型门面(原「手维护镜像」,已退役)—— 单一来源在
 * `@bilibili-notify/internal`,这里只做 `import type` re-export(编译后全擦除,
 * web 运行时仍是纯 JSON 消费者)。本文件自留的只剩 UI 侧派生别名与 PATCH 工具类型。
 */

import type {
	AIProviderProfileView,
	AISettingsView,
	SecretCellDraft,
} from "@bilibili-notify/contract";
import type { GlobalConfig } from "@bilibili-notify/internal";

export type {
	AIPersona,
	AISettings,
	AppConfig,
	CardKind,
	CardsOverrides,
	CardsSettings,
	ContentFilters,
	GlobalConfig,
	GlobalDefaults,
	ImageGroupSettings,
	LiveStartSettings,
	LiveStreamingSettings,
	LogLevel,
	MembershipSettings,
	MembershipTemplateBundle,
	MembershipTemplateEntry,
	ModuleLogLevels,
	ScheduleConfig,
	SuperchatSettings,
	TemplateBundle,
} from "@bilibili-notify/internal";

/**
 * Patch payload for /api/settings — deeply partial; server merges + revalidates.
 *
 * 任意层级都可显式为 `null` = 删除该键(JSON Merge Patch 语义,同
 * `@bilibili-notify/internal/patch`)。缺席的键表示「不改」,所以清除一个可选字段
 * 只能靠 null,不能靠把键拿掉。
 */
type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T;
export type GlobalConfigPatch = DeepPartial<GlobalConfig>;

/**
 * `/api/settings` 下发的那一份:核心设置的顶层键,各集成的设置挂在自己的键下(今天只有 B 站,ADR-0021 决策 42 下
 * 10-01 的 🔗)。集成那几份的形状由各集成定,面板只在画到它的那一处认得(系统页;第 4 期起按集成的描述画)。
 */
export type GlobalsResponse = GlobalConfig & { readonly [integrationKey: string]: unknown };

/**
 * 智能女仆页的草稿:密钥格要么还是下发的遮挡(没动),要么是字符串(换了新的;空串 = 清空)。
 * 下发的形状(密钥格是遮挡或空串)是 contract 的 {@link AISettingsView}。
 */
export type AISettingsDraft = AISettingsView<SecretCellDraft>;
export type AIProviderProfileDraft = AIProviderProfileView<SecretCellDraft>;

/** `/api/settings` 的 PATCH:核心那份的补丁,各集成的补丁挂在自己的键下(与 {@link GlobalsResponse} 同一个形状)。 */
export type GlobalsPatch = GlobalConfigPatch & { [integrationKey: string]: unknown };
