import { EXTENSION_MOUNT_PREFIX } from "@bilibili-notify/contract";

/**
 * 一个拓展对外的地址 —— `ws(s)://<地址栏的 host>/ext/<id>`,桥那台机器要填的就是它。
 *
 * **在浏览器里现算**(ADR-0019 决策 28 的 `{ host: "extensionUrl" }`):主人此刻正是**经这个
 * 地址**看着这一页,所以它至少是一条通到 BN 的真路。服务端算不了这件事(它只知道自己绑在哪个
 * 口上,不知道外面怎么访问得到它),而写死 `127.0.0.1` 是最坏的那个答案 —— 桥常在另一台机器上。
 *
 * 手写的桥页与照声明画的页共用这一份:各算各的话,两页印给主人的地址迟早对不上。
 */
export function extensionAddress(extensionId: string): string {
	const scheme = window.location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${window.location.host}${EXTENSION_MOUNT_PREFIX}/${extensionId}`;
}
