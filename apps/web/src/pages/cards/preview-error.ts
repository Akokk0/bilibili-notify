import { i18n } from "../../i18n";
/**
 * 预览失败时标题上那一行。
 *
 * 「断线」必须和「服务端返回了错误」分开说 —— 前者服务端可能压根不知道自己被放了
 * 鸽子(渲染照样跑完、日志照样写「渲染完成」),用户却只看到一句 `Failed to fetch`。
 * 把结论摆在标题上,才不至于让人拿着两份对不上的证据来回问。
 */

import { OFFLINE_STATUS } from "../../services/api";
import { issueTextsOf } from "../../services/error-text";

/** 标题只看错误的这两格:`status`(断线是 0)与 `code`(服务端的标准码)。 */
interface PreviewFailure {
	status?: number;
	code?: string;
}

/**
 * 标题按**码**挑,不按 HTTP 状态码(ADR-0026):没配浏览器是 `not_configured`,引擎还没就绪
 * 是 `unavailable`,从前同挤在 503 里面板分不出来。断线不是服务端说的话(没有码,状态是 0),
 * 仍单独成一档。
 */
export function previewErrorTitle(err: PreviewFailure | undefined): string {
	// 先挡住「没有状态码」这一档。`undefined === 0` 本就是 false,但测试里 mock 掉
	// services/api 时 OFFLINE_STATUS 会变成 undefined —— 那时每个无状态码的错误都会
	// 谎报「连接中断」。显式挡一道,判断就不再依赖那个 import 有没有被 mock 全。
	if (err?.status !== undefined && err.status === OFFLINE_STATUS)
		return i18n.t("skinUi.preview-error.1");
	if (err?.code === "not_configured") return i18n.t("skinUi.preview-error.2");
	return i18n.t("skinUi.preview-error.3");
}

/**
 * 断线时补一句「接下来查什么」。渲染是串行的,一屏四张卡时最后一张等得最久,所以
 * 断线几乎总是先从它身上冒出来 —— 排查方向基本就是超时那一类。
 */
export function previewErrorHint(status: number | undefined): string | null {
	if (status === undefined || status !== OFFLINE_STATUS) return null;
	return i18n.t("skinUi.preview-error.4");
}

/**
 * 服务端拒收时那串**逐条**原因(装包门 / 资产闸的错误体:`message` 一句概括,逐条在 `issues`)。
 *
 * 有逐条原因就列它们;一句话的失败没有 `issues`,退回 `message`,至少还有一句话。
 * **自编一句「失败了」等于把线索吞掉**:装包门那串正是主人照着改的东西。
 */
export function serverErrors(err: unknown): string[] {
	if (!err) return [];
	const lines = issueTextsOf(err);
	if (lines.length > 0) return lines;
	return [String((err as Error).message)];
}
