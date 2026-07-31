/**
 * 预览失败时标题上那一行。
 *
 * 「断线」必须和「服务端返回了错误」分开说 —— 前者服务端可能压根不知道自己被放了
 * 鸽子(渲染照样跑完、日志照样写「渲染完成」),用户却只看到一句 `Failed to fetch`。
 * 把结论摆在标题上,才不至于让人拿着两份对不上的证据来回问。
 */

import { OFFLINE_STATUS } from "../../services/api";

export function previewErrorTitle(status: number | undefined): string {
	// 先挡住「没有状态码」这一档。`undefined === 0` 本就是 false,但测试里 mock 掉
	// services/api 时 OFFLINE_STATUS 会变成 undefined —— 那时每个无状态码的错误都会
	// 谎报「连接中断」。显式挡一道,判断就不再依赖那个 import 有没有被 mock 全。
	if (status === undefined) return "渲染失败";
	if (status === OFFLINE_STATUS) return "连接中断";
	if (status === 503) return "puppeteer 未配置";
	if (status === 501) return "kind 暂未支持";
	return "渲染失败";
}

/**
 * 断线时补一句「接下来查什么」。渲染是串行的,一屏四张卡时最后一张等得最久,所以
 * 断线几乎总是先从它身上冒出来 —— 排查方向基本就是超时那一类。
 */
export function previewErrorHint(status: number | undefined): string | null {
	if (status === undefined || status !== OFFLINE_STATUS) return null;
	return "卡片渲染较慢，若经反向代理访问，请把读超时调到 120s 以上；也可能是服务端刚重启（内存不足时会被系统杀掉）。";
}
