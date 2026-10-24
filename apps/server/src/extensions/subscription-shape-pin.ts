/**
 * 订阅源那一口的几份手写镜像,与 zod **双向严格相等**地钉在这里(同 `view-shape-pin.ts`,ADR-0019
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
	ExtensionSubscriptionDisplay,
	ExtensionSubscriptionEventKind,
	LiveDetails,
	LiveSignalReport,
	LiveStatusResult,
	PostReport,
	SourceHealth,
} from "@bilibili-notify/extension";
import type {
	ExtensionCreatorCandidatesSchema,
	ExtensionCreatorProfileReportSchema,
	ExtensionLiveSignalReportSchema,
	ExtensionLiveStatusResultSchema,
	ExtensionManifestV2,
	ExtensionPostReportSchema,
	ExtensionSourceHealthSchema,
	SubscriptionEventKind,
} from "@bilibili-notify/internal";
import type { z } from "zod";
import type { Equals, Pinned } from "./view-shape-pin.js";

/** 清单里订阅源那一段。 */
type ManifestSubscription = NonNullable<ExtensionManifestV2["contributes"]["subscription"]>;

export type SubscriptionDisplayPinned = Pinned<
	Equals<ManifestSubscription["display"], ExtensionSubscriptionDisplay>
>;
export type SubscriptionEventKindPinned = Pinned<
	Equals<SubscriptionEventKind, ExtensionSubscriptionEventKind>
>;
export type SubscriptionEventsPinned = Pinned<
	Equals<ManifestSubscription["events"][number], ExtensionSubscriptionEventKind>
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
