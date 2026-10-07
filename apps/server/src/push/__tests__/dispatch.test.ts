/**
 * 「拿着一条连接去矩阵里找 adapter」这一步的守卫。
 *
 * 它看起来只是一行 `find`,但**问错问题会静默失败**:桥后面挂着 telegram 时,消息里
 * 报的平台是 `telegram`,而认领它的 adapter 声明的是 `bridge` —— 按消息里的平台名去
 * 找是找不到的,而且不报错,症状是「群里贴了链接没回卡、日志说连接不存在」。
 */

import type { Connection } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { adapterForConnection } from "../dispatch.js";

function direct(platform: string): Connection {
	return {
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		name: "直连",
		enabled: true,
		kind: "direct",
		platform,
		connector: "ws",
		config: {},
	} as Connection;
}

function bridge(): Connection {
	return {
		id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		name: "家里那台 koishi",
		enabled: true,
		kind: "extension",
		extensionId: "bridge",
		config: { token: "t0ken", bridgeKind: "koishi" },
	} as Connection;
}

const onebot = { platforms: ["onebot"] as const };
const bridgeAdapter = { platforms: ["bridge"] as const };
const matrix = [onebot, bridgeAdapter];

describe("adapterForConnection", () => {
	it("直连认它的平台名", () => {
		expect(adapterForConnection(matrix, direct("onebot"))).toBe(onebot);
	});

	it("桥接入认 bridge 这个键 —— 不是它背后挂着的那些平台", () => {
		expect(adapterForConnection(matrix, bridge())).toBe(bridgeAdapter);
	});

	it("没人认领就是没人认领", () => {
		expect(adapterForConnection(matrix, direct("feishu"))).toBeUndefined();
	});

	it("认领同一个键的有多个时给第一个 —— 与矩阵的声明顺序一致", () => {
		const shadow = { platforms: ["onebot"] as const };
		expect(adapterForConnection([onebot, shadow], direct("onebot"))).toBe(onebot);
	});
});
