/**
 * TD1 — 编译期漂移护栏。
 *
 * `types/domain.ts` 是 `packages/internal/src/schema/*` 的**手维护镜像**(web
 * 端是纯 JSON 消费者,不在运行时 import 核心)。此前无任何护栏:规范 schema
 * 加了新键而镜像没跟,PATCH body 会**静默丢字段**且 CI 全绿。
 *
 * 本文件用**纯类型**断言把"规范键集 ⊆ 镜像键集"钉死:任何一侧 import 仅
 * `import type`(编译后完全擦除,Vite 产物零影响,仅 tsc / vitest typecheck
 * 能看见)。规范新增键而镜像漏镜像 → 下面某条 `Expect<...>` 变 `false` →
 * `vp run typecheck`(tsc --noEmit,apps/web tsconfig include: src)失败。
 *
 * 方向特意取"规范键 ⊆ 镜像键":镜像可有 UI 专属多余键(不报),只在镜像
 * **少**了规范键(= 会丢 PATCH 字段)时失败 —— 正是报告关心的那类漂移。
 */

import type {
	AIOverride as CanonAIOverride,
	AISettings as CanonAISettings,
	CardStyle as CanonCardStyle,
	ContentFilters as CanonContentFilters,
	FeatureKey as CanonFeatureKey,
	PushTarget as CanonPushTarget,
	QQOfficialAdapterConfig as CanonQQOfficialAdapterConfig,
	QQOfficialSession as CanonQQOfficialSession,
	ScheduleConfig as CanonScheduleConfig,
	TemplateBundle as CanonTemplateBundle,
	WebhookAdapterConfig as CanonWebhookAdapterConfig,
} from "@bilibili-notify/internal";
import { describe, it } from "vite-plus/test";
import type {
	AIOverride as MirrorAIOverride,
	CardStyleFull as MirrorCardStyle,
	ContentFiltersFull as MirrorContentFilters,
	FeatureKey as MirrorFeatureKey,
	PushTarget as MirrorPushTarget,
	QQOfficialAdapterConfig as MirrorQQOfficialAdapterConfig,
	QQOfficialSession as MirrorQQOfficialSession,
	ScheduleFull as MirrorSchedule,
	TemplateBundleFull as MirrorTemplate,
	WebhookAdapterConfig as MirrorWebhookAdapterConfig,
} from "./domain";
import type { AISettings as MirrorAISettings } from "./globals";

type Expect<T extends true> = T;
/** 严格相等(双向)。 */
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** 规范键集 ⊆ 镜像键集(镜像可多,不可少)。 */
type CanonKeysCovered<Canon, Mirror> = keyof Canon extends keyof Mirror ? true : false;

// FeatureKey:特性最常被新增,取双向严格相等(增/删/改名都视为漂移)。
type _FeatureKeyExact = Expect<Equal<CanonFeatureKey, MirrorFeatureKey>>;

// 各 **PATCH 可编辑** 子结构:规范键必须都在镜像里(否则该字段经线被丢)。
// 范围特意限定为 dashboard 真正会 PATCH 的编辑面 —— 不含只读/bootstrap
// (env 注入、永不经 UI 改;强行镜像反成误报)。Subscription 的编辑面即其
// overrides(下列各 *Full + AIOverride/AISettings)+ routing(键为 FeatureKey,
// 由上面 FeatureKey 严等覆盖)。
type _Filters = Expect<CanonKeysCovered<CanonContentFilters, MirrorContentFilters>>;
type _Schedule = Expect<CanonKeysCovered<CanonScheduleConfig, MirrorSchedule>>;
type _CardStyle = Expect<CanonKeysCovered<CanonCardStyle, MirrorCardStyle>>;
type _Template = Expect<CanonKeysCovered<CanonTemplateBundle, MirrorTemplate>>;
type _AIOverride = Expect<CanonKeysCovered<CanonAIOverride, MirrorAIOverride>>;
type _AISettings = Expect<CanonKeysCovered<CanonAISettings, MirrorAISettings>>;
// 独立端 Dashboard 只镜像自己可编辑的平台。宿主专用隐藏平台（Koishi/AstrBot）
// 由对应宿主壳消费，不进入 apps/web 的平台工厂和普通选择器。
type StandaloneCanonPushTarget = Exclude<CanonPushTarget, { platform: "koishi-bot" | "astrbot" }>;
type _PushTarget = Expect<CanonKeysCovered<StandaloneCanonPushTarget, MirrorPushTarget>>;
type _WebhookAdapterConfig = Expect<
	CanonKeysCovered<CanonWebhookAdapterConfig, MirrorWebhookAdapterConfig>
>;
// QQ 官方机器人 adapter config / session 镜像(独立端可编辑平台,凭据 + 会话寻址)。
type _QQOfficialAdapterConfig = Expect<
	CanonKeysCovered<CanonQQOfficialAdapterConfig, MirrorQQOfficialAdapterConfig>
>;
type _QQOfficialSession = Expect<CanonKeysCovered<CanonQQOfficialSession, MirrorQQOfficialSession>>;

// 引用一次,避免 "unused type" 噪音(类型层断言已在上面 tsc 检查时生效)。
export type _DomainConformance = [
	_FeatureKeyExact,
	_Filters,
	_Schedule,
	_CardStyle,
	_Template,
	_AIOverride,
	_AISettings,
	_PushTarget,
	_WebhookAdapterConfig,
	_QQOfficialAdapterConfig,
	_QQOfficialSession,
];

describe("types/domain.ts 漂移护栏 (TD1)", () => {
	it("规范 schema 键集 ⊆ 手维护镜像键集(真断言在编译期 tsc 生效)", () => {
		// 运行时空体:本守卫是纯类型断言,由 `vp run typecheck` 强制。
		// 若上方任一 Expect<...> 不成立,tsc --noEmit 会直接报错阻断 CI。
	});
});
