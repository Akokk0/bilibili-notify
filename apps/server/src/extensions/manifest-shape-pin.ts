/**
 * 清单两口(订阅源、推送)与第 3 版上报的几份手写镜像,与 zod **双向严格相等**地钉在这里(同 `view-shape-pin.ts`,ADR-0019
 * 决策 39 的那条规矩)。
 *
 * 一份是 `@bilibili-notify/internal` 的 zod(清单的 `contributes.subscription` 与第 3 版上报),一份是
 * `@bilibili-notify/extension` 的手写镜像。单向赋值漏得过「wire 那边多一个可选键」—— 拓展照着 wire
 * 写了那一格,宿主一核就是「多出来的键」,整条上报被拒,而类型、测试、构建全绿。
 *
 * 只有类型,不进 bundle;`tsc --noEmit` 查的就是它。
 */

import type {
	CreatorCandidate,
	CreatorProfileReport,
	ExtensionSubscriptionView,
	LiveDetails,
	LiveSignalReport,
	LiveStatusResult,
	PlatformAdapterDescriptor,
	PostReport,
	SourceHealth,
} from "@bilibili-notify/extension";
import type {
	CREATOR_SEARCH_INPUTS,
	EXTENSION_SOURCE_FEATURES,
	ExtensionCreatorCandidatesSchema,
	ExtensionCreatorProfileReportSchema,
	ExtensionLiveSignalReportSchema,
	ExtensionLiveStatusResultSchema,
	ExtensionManifestV3,
	ExtensionPostReportSchema,
	ExtensionSourceHealthSchema,
} from "@bilibili-notify/internal";
import type { z } from "zod";
import type { Equals, Pinned } from "./view-shape-pin.js";

/** 清单里订阅源那一段。 */
type ManifestSubscription = NonNullable<ExtensionManifestV3["contributes"]["subscription"]>;
type ManifestPush = NonNullable<ExtensionManifestV3["contributes"]["push"]>;
type ReadonlyArrays<T> = {
	[K in keyof T]: NonNullable<T[K]> extends readonly unknown[]
		? Readonly<NonNullable<T[K]>> | Extract<T[K], undefined>
		: T[K];
};

/** 清单订阅段去掉装包用的 `cardSkin`,与过 wire 的订阅视图双向严格相等。 */
export type SubscriptionPinned = Pinned<
	Equals<ReadonlyArrays<Omit<ManifestSubscription, "cardSkin">>, ExtensionSubscriptionView>
>;
/** 清单能声明的特性与 wire 视图的特性字面量双向严格相等。 */
export type SubscriptionFeaturesPinned = Pinned<
	Equals<
		(typeof EXTENSION_SOURCE_FEATURES)[number],
		ExtensionSubscriptionView["supportedFeatures"][number]
	>
>;
/** 清单声明的搜人输入种类与 wire 视图的字面量双向严格相等。 */
export type SubscriptionSearchInputsPinned = Pinned<
	Equals<
		(typeof CREATOR_SEARCH_INPUTS)[number],
		NonNullable<ExtensionSubscriptionView["searchAccepts"]>[number]
	>
>;
/** 推送段的纯外观逐格严格相等;字段表由下一行单向钉住可赋值。 */
export type PushDisplayPinned = Pinned<
	Equals<Omit<ManifestPush, "settingsFields">, Omit<PlatformAdapterDescriptor, "settingsFields">>
>;
export type PushSettingsFieldsPinned = Pinned<
	NonNullable<
		ManifestPush["settingsFields"]
	>[number] extends PlatformAdapterDescriptor["settingsFields"][number]
		? true
		: false
>;
// ---- Version 3 reports and read results ---------------------------------------------------

export type ExtensionPostReportPinned = Pinned<
	Equals<z.infer<typeof ExtensionPostReportSchema>, PostReport>
>;
export type ExtensionLiveSignalReportPinned = Pinned<
	Equals<z.infer<typeof ExtensionLiveSignalReportSchema>, LiveSignalReport>
>;
export type ExtensionLiveDetailsPinned = Pinned<
	Equals<
		Extract<z.infer<typeof ExtensionLiveSignalReportSchema>, { kind: "start" }>["details"],
		LiveDetails
	>
>;
export type ExtensionCreatorProfileReportPinned = Pinned<
	Equals<z.infer<typeof ExtensionCreatorProfileReportSchema>, CreatorProfileReport>
>;
export type ExtensionCreatorCandidatesPinned = Pinned<
	Equals<z.infer<typeof ExtensionCreatorCandidatesSchema>, CreatorCandidate[]>
>;
export type ExtensionLiveStatusResultPinned = Pinned<
	Equals<z.infer<typeof ExtensionLiveStatusResultSchema>, LiveStatusResult>
>;
export type ExtensionSourceHealthPinned = Pinned<
	Equals<z.infer<typeof ExtensionSourceHealthSchema>, SourceHealth>
>;
