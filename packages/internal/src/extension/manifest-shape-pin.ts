/**
 * 清单两口(订阅源、推送)与第 3 版上报的推导类型,与同在 internal 的 zod
 * **双向严格相等**地钉在这里(同 `view-shape-pin.ts`,ADR-0019 决策 39 的那条规矩)。
 *
 * 一份是同一包的 zod(清单的 `contributes.subscription` 与第 3 版上报),一份是
 * `extension/index.ts` 从核心域模型窄化推导的类型。单向赋值漏得过「一边多一个可选键」—— 拓展照着
 * 类型写了那一格,宿主一核就是「多出来的键」,整条上报被拒,而类型、测试、构建全绿。
 *
 * 只有类型,不进 bundle;`tsc --noEmit` 查的就是它。
 */

import type { z } from "zod";
import type { PlatformAdapterDescriptor } from "../push-source";
import type {
	ExtensionCreatorCandidatesSchema,
	ExtensionCreatorProfileReportSchema,
	ExtensionLiveSignalReportSchema,
	ExtensionLiveStatusResultSchema,
	ExtensionManifestV3,
	ExtensionPostReportSchema,
	ExtensionSourceHealthSchema,
	SettingsFieldSchema,
} from "../schema";
import type { SettingsField, SettingsScalarField } from "../settings-field";
import type { CreatorCandidate, CreatorProfileReport, SourceHealth } from "../source";
import type {
	ExtensionLiveDetails,
	ExtensionLiveSignalReport,
	ExtensionLiveStatusResult,
	ExtensionPostReport,
} from "./index";
import type { Equals, Pinned } from "./view-shape-pin.js";
import type { ExtensionSubscriptionView } from "./wire";

/** 清单里订阅源那一段。 */
type ManifestSubscription = NonNullable<ExtensionManifestV3["contributes"]["subscription"]>;
type ManifestPush = NonNullable<ExtensionManifestV3["contributes"]["push"]>;
type ReadonlyArrays<T> = T extends readonly (infer U)[]
	? ReadonlyArray<ReadonlyArrays<U>>
	: T extends object
		? { [K in keyof T]: ReadonlyArrays<T[K]> }
		: T;

/** 清单订阅段去掉装包用的 `cardSkin`,与过 wire 的订阅视图双向严格相等。 */
export type SubscriptionPinned = Pinned<
	Equals<ReadonlyArrays<Omit<ManifestSubscription, "cardSkin">>, ExtensionSubscriptionView>
>;
/** 推送段的纯外观逐格严格相等。 */
export type PushDisplayPinned = Pinned<
	Equals<Omit<ManifestPush, "settingsFields">, Omit<PlatformAdapterDescriptor, "settingsFields">>
>;
/** 推送段的字段表与描述符的字段表严格相等。 */
export type PushSettingsFieldsPinned = Pinned<
	Equals<
		ReadonlyArrays<NonNullable<ManifestPush["settingsFields"]>>,
		PlatformAdapterDescriptor["settingsFields"]
	>
>;
/** zod 字段规则推出的形状与手写设置字段严格相等。 */
export type SettingsFieldsPinned = Pinned<
	Equals<ReadonlyArrays<z.infer<typeof SettingsFieldSchema>>, SettingsField>
>;
/** 清单推送段的字段元素与单值设置字段严格相等。 */
export type ManifestSettingsFieldsPinned = Pinned<
	Equals<ReadonlyArrays<NonNullable<ManifestPush["settingsFields"]>[number]>, SettingsScalarField>
>;
// ---- Version 3 reports and read results ---------------------------------------------------

export type ExtensionPostReportPinned = Pinned<
	Equals<z.infer<typeof ExtensionPostReportSchema>, ExtensionPostReport>
>;
export type ExtensionLiveSignalReportPinned = Pinned<
	Equals<z.infer<typeof ExtensionLiveSignalReportSchema>, ExtensionLiveSignalReport>
>;
export type ExtensionLiveDetailsPinned = Pinned<
	Equals<
		Extract<z.infer<typeof ExtensionLiveSignalReportSchema>, { kind: "start" }>["details"],
		ExtensionLiveDetails
	>
>;
export type ExtensionCreatorProfileReportPinned = Pinned<
	Equals<z.infer<typeof ExtensionCreatorProfileReportSchema>, CreatorProfileReport>
>;
export type ExtensionCreatorCandidatesPinned = Pinned<
	Equals<z.infer<typeof ExtensionCreatorCandidatesSchema>, CreatorCandidate[]>
>;
export type ExtensionLiveStatusResultPinned = Pinned<
	Equals<z.infer<typeof ExtensionLiveStatusResultSchema>, ExtensionLiveStatusResult>
>;
export type ExtensionSourceHealthPinned = Pinned<
	Equals<z.infer<typeof ExtensionSourceHealthSchema>, SourceHealth>
>;
