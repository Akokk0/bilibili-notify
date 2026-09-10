/**
 * 🔴 **面板叫人填的那条地址,开发时必须真的通得到。**
 *
 * 拓展页把桥的接入地址印成 `ws://<当前页面的 host>/ext/<id>` —— 生产环境下面板与服务端
 * 同源,算得对;**开发时面板在 Vite 的 5173,而服务端在 8787**。Vite 不代理那个前缀的话,
 * 主人照着抄下来的地址会打到 Vite 自己身上,得到一句
 * 「WebSocket was closed before the connection was established」。
 *
 * 主人 2026-09-10 真机第一次接 koishi 就栽在这儿。这条守卫钉的是**性质**而不是现状:
 * 面板印什么前缀,开发代理就得转什么前缀 —— 两边都从同一个常量来,改一个另一个就红。
 */

import { EXTENSION_MOUNT_PREFIX } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import config from "../../vite.config";

/** `defineConfig` 可能收一个函数(按 mode 分叉),今天不是 —— 是的话这条得跟着改。 */
function proxyTable(): Record<string, unknown> {
	const proxy = (config as { server?: { proxy?: Record<string, unknown> } }).server?.proxy;
	if (!proxy) throw new Error("vite.config 里没有 server.proxy 了");
	return proxy;
}

describe("开发代理", () => {
	it("拓展挂载点要转过去,而且要开 ws —— 桥那条长连接走的就是它", () => {
		const entry = proxyTable()[EXTENSION_MOUNT_PREFIX] as { target?: string; ws?: boolean };
		expect(entry, `代理表里没有 ${EXTENSION_MOUNT_PREFIX}`).toBeTruthy();
		expect(entry.ws).toBe(true);
		// 取图口(`/ext/<id>/blob/<id>`)是普通 HTTP,与 WS 同一个前缀、同一条代理。
		expect(entry.target).toContain("8787");
	});

	/** 面板还从这两条上拿东西 —— 一起钉住,免得哪天挪了前缀只在开发时坏。 */
	it("接口与面板的 WS 也在表里", () => {
		const table = proxyTable();
		expect(Object.keys(table)).toEqual(expect.arrayContaining(["/api", "/ws"]));
	});
});
