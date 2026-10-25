/**
 * 清单两口(订阅源、推送)与第 3 版上报的几份手写镜像,与同在 internal 的 zod
 * **双向严格相等**地钉在这里(同 `view-shape-pin.ts`,ADR-0019 决策 39 的那条规矩)。
 *
 * 一份是同一包的 zod(清单的 `contributes.subscription` 与第 3 版上报),一份是
 * `extension/index.ts` 的手写镜像。单向赋值漏得过「wire 那边多一个可选键」—— 拓展照着
 * wire 写了那一格,宿主一核就是「多出来的键」,整条上报被拒,而类型、测试、构建全绿。
 *
 * 只有类型,不进 bundle;`tsc --noEmit` 查的就是它。
 */

import type { z } from "zod";
import type {
	ExtensionCreatorCandidatesSchema,
	ExtensionCreatorProfileReportSchema,
	ExtensionLiveSignalReportSchema,
	ExtensionLiveStatusResultSchema,
	ExtensionManifestV3,
	ExtensionPostReportSchema,
	ExtensionSourceHealthSchema,
} from "../schema";
import type { CreatorCandidate, CreatorProfileReport, SourceHealth } from "../source";
import type { LiveDetails, LiveSignalReport, LiveStatusResult, PostReport } from "./index";
import type { Equals, Pinned } from "./view-shape-pin.js";
import type { ExtensionSubscriptionView, PlatformAdapterDescriptor } from "./wire";

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
