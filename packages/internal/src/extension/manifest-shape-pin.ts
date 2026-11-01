/**
 * 清单两口(订阅源、推送)与当前契约上报的推导类型,与同在 internal 的 zod
 * **双向严格相等**地钉在这里(同 `view-shape-pin.ts`,ADR-0019 决策 39 的那条规矩)。
 *
 * 一份是同一包的 zod(清单的 `contributes.subscription` 与当前契约上报),一份是
 * `extension/index.ts` 从核心域模型窄化推导的类型。单向赋值漏得过「一边多一个可选键」—— 拓展照着
 * 类型写了那一格,宿主一核就是「多出来的键」,整条上报被拒,而类型、测试、构建全绿。
 *
 * 只有类型,不进 bundle;`tsc --noEmit` 查的就是它。
 */

import type { z } from "zod";
import type { EXTENSION_SOURCE_FEATURES } from "../features";
import type { PlatformAdapterDescriptor } from "../push-source";
import type {
	ExtensionCreatorCandidatesSchema,
	ExtensionCreatorProfileReportSchema,
	ExtensionLiveSignalReportSchema,
	ExtensionLiveStatusResultSchema,
	ExtensionManifest,
	ExtensionPostReportSchema,
	ExtensionSourceHealthSchema,
	SettingsFieldSchema,
} from "../schema";
import type { SettingsField, SettingsScalarField } from "../settings-field";
import type {
	CreatorCandidate,
	CreatorProfileReport,
	SourceDescriptor,
	SourceHealth,
} from "../source";
import type {
	ExtensionLiveDetails,
	ExtensionLiveSignalReport,
	ExtensionLiveStatusResult,
	ExtensionPostReport,
} from "./index";
import type { Equals, Pinned } from "./view-shape-pin.js";

/** 清单里订阅源那一段。 */
type ManifestSubscription = NonNullable<ExtensionManifest["contributes"]["subscription"]>;
type ManifestPush = NonNullable<ExtensionManifest["contributes"]["push"]>;
type ReadonlyArrays<T> = T extends readonly (infer U)[]
	? ReadonlyArray<ReadonlyArrays<U>>
	: T extends object
		? { [K in keyof T]: ReadonlyArrays<T[K]> }
		: T;

/** 清单订阅段去掉装包用的 `cardSkin`:拓展来源的描述符就是它(`manifestSourceDescriptor`)。 */
type ManifestDescriptor = ReadonlyArrays<Omit<ManifestSubscription, "cardSkin">>;
/**
 * 与 `SourceDescriptor` 逐格严格相等:1.0 清单不收会员体系与附加项,特性另一条钉。
 * 描述符加了格、清单没跟上(或反过来),这里就红。
 */
export type SubscriptionPinned = Pinned<
	Equals<
		Omit<ManifestDescriptor, "supportedFeatures">,
		Omit<SourceDescriptor, "membershipPrograms" | "supportedExtras" | "supportedFeatures">
	>
>;
/** 清单能声明的特性是 1.0 开放的那几种(描述符本身收全部特性键)。 */
export type SubscriptionFeaturesPinned = Pinned<
	Equals<
		ManifestDescriptor["supportedFeatures"],
		readonly (typeof EXTENSION_SOURCE_FEATURES)[number][]
	>
>;
/** 推送段的纯外观逐格严格相等。 */
export type PushDisplayPinned = Pinned<
	Equals<Omit<ManifestPush, "settingsFields">, Omit<PlatformAdapterDescriptor, "settingsFields">>
>;
/** 拓展推送段只开放单值字段;内置连接描述的条件字段与键值表不进入清单。 */
export type PushSettingsFieldsPinned = Pinned<
	Equals<
		ReadonlyArrays<NonNullable<ManifestPush["settingsFields"]>>,
		readonly SettingsScalarField[]
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
// ---- Current contract reports and read results ---------------------------------------------------

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
