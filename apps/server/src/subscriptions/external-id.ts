import {
	EXTERNAL_ID_MAX,
	type Failure,
	fail,
	type SourceDescriptor,
} from "@bilibili-notify/internal";
import { EXTERNAL_ID_TEXTS } from "./external-id-texts.js";

/** 核外部 id 要用到的描述符那两格:拓展来源没有描述符对象,拿清单里的外观(同样有这两格)也行。 */
export type ExternalIdSpec = Pick<SourceDescriptor, "label" | "externalIdRegex">;

/**
 * 外部 id 合不合来源声明的格式(ADR-0021 决策 14 下 10-15 的 🔗)。**核心不认平台**:格式只来自来源
 * 自己的 `externalIdRegex`,声明了就整串匹配;没声明(或认不出这个来源)不替它做主 —— 非空、限长归中立的
 * 订阅 schema,这里不重复。合格回 `undefined`。
 *
 * 只核新建:身份建好以后改不动(store 拒),已有的订阅不回头核。声明的正则在清单校验 / 注册时已经
 * 体检过(长度、疑似灾难性回溯、可编译);被核的值再封一道顶(`EXTERNAL_ID_MAX`),写坏的值拖不住保存。
 */
export function externalIdRefusal(
	spec: ExternalIdSpec | undefined,
	externalId: unknown,
): Failure | undefined {
	const source = spec?.externalIdRegex;
	if (spec === undefined || source === undefined) return undefined;
	if (
		typeof externalId === "string" &&
		externalId.length <= EXTERNAL_ID_MAX &&
		// 外面包一层非捕获组再锚住两头:声明里带 `|` 也是整串匹配,自带的 ^ 与 $ 不妨碍。
		new RegExp(`^(?:${source})$`).test(externalId)
	) {
		return undefined;
	}
	return fail("invalid", EXTERNAL_ID_TEXTS.mismatch(spec.label), {
		issues: [
			{
				path: ["identity", "externalId"],
				message: EXTERNAL_ID_TEXTS.mismatchIssue(spec.label),
			},
		],
	});
}
