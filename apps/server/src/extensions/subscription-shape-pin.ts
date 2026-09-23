/**
 * 订阅源那一口的几份手写镜像,与 zod **双向严格相等**地钉在这里(同 `view-shape-pin.ts`,ADR-0019
 * 决策 39 的那条规矩)。
 *
 * 一份是 `@bilibili-notify/internal` 的 zod(清单的 `contributes.subscription`、宿主核解析门候选用的
 * 那份),一份是 `@bilibili-notify/extension/wire` 的手写镜像(拓展照它写、面板照它画)。单向赋值
 * 漏得过「wire 那边多一个可选键」—— 拓展照着 wire 写了那一格,宿主一核就是「多出来的键」,整次解析回
 * 「形状不对」,而类型、测试、构建全绿。
 *
 * 只有类型,不进 bundle;`tsc --noEmit` 查的就是它。
 */

import type {
	ExtensionSubscriptionCandidate,
	ExtensionSubscriptionDisplay,
	ExtensionSubscriptionEventKind,
} from "@bilibili-notify/extension";
import type {
	ExtensionManifestV2,
	SubscriptionCandidateSchema,
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
export type SubscriptionCandidatePinned = Pinned<
	Equals<z.infer<typeof SubscriptionCandidateSchema>, ExtensionSubscriptionCandidate>
>;
