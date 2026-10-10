/**
 * 「拿着一条连接去矩阵里找 adapter」这一步的守卫。
 *
 * 它看起来只是一行 `find`,但**问错问题会静默失败**:桥后面挂着 telegram 时,消息里
 * 报的平台是 `telegram`,而认领它的 adapter 声明的是 `bridge` —— 按消息里的平台名去
 * 找是找不到的,而且不报错,症状是「群里贴了链接没回卡、日志说连接不存在」。所以按连接的
 * `adapterKey` 找。
 */

import type { Connection } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { adapterForConnection, routeConnection } from "../dispatch.js";

function connectionOf(adapterKey: string, platform: string, settings: unknown = {}): Connection {
	return {
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		name: "连接",
		enabled: true,
		adapterKey,
		platform,
		settings,
		platformSnapshot: snapshotFor(platform),
	};
}

const direct = (platform: string) =>
	connectionOf(
		platform === "onebot" || platform === "qq-official" ? platform : "webhook",
		platform,
	);
const bridge = () => connectionOf("bridge", "telegram");

const onebot = { adapterKey: "onebot" };
const bridgeAdapter = { adapterKey: "bridge" };
const webhookAdapter = { adapterKey: "webhook" };
const matrix = [onebot, bridgeAdapter, webhookAdapter];

describe("adapterForConnection", () => {
	it("按连接的 adapterKey 认", () => {
		expect(adapterForConnection(matrix, direct("onebot"))).toBe(onebot);
	});

	it("桥接入认 bridge 这个键 —— 不是它背后挂着的那些平台", () => {
		expect(adapterForConnection(matrix, bridge())).toBe(bridgeAdapter);
	});

	it("没人认领就是没人认领", () => {
		expect(adapterForConnection(matrix, direct("qq-official"))).toBeUndefined();
	});

	it("webhook 那一族的四个平台都归 adapterKey 为 webhook 的那一个", () => {
		for (const platform of ["feishu", "dingtalk", "wecom", "generic"]) {
			expect(adapterForConnection(matrix, direct(platform)), platform).toBe(webhookAdapter);
		}
	});

	it("认领同一个键的有多个时给第一个 —— 与矩阵的声明顺序一致", () => {
		const shadow = { adapterKey: "onebot" };
		expect(adapterForConnection([onebot, shadow], direct("onebot"))).toBe(onebot);
	});

	it("平台名不参与:同一个平台名、不同的 adapterKey,认的是 adapterKey", () => {
		// 桥借来的 bot 自报平台叫 onebot,认领它的仍是桥。
		const borrowed = connectionOf("bridge", "onebot");
		expect(adapterForConnection(matrix, borrowed)).toBe(bridgeAdapter);
	});
});

describe("routeConnection", () => {
	const schema = z.object({ url: z.string(), retries: z.number().default(3) });
	const adapters = [
		{ adapterKey: "webhook", settingsSchema: schema },
		{ adapterKey: "bridge", settingsSchema: z.unknown() },
	];

	it("找到适配器且设置合法:回解过的连接(补了默认值),原连接不被改动", () => {
		const connection = connectionOf("webhook", "generic", { url: "https://x" });
		const route = routeConnection(adapters, connection);
		expect(route.ok).toBe(true);
		if (!route.ok) return;
		expect(route.adapter).toBe(adapters[0]);
		expect(route.connection.settings).toEqual({ url: "https://x", retries: 3 });
		expect(connection.settings).toEqual({ url: "https://x" });
		expect(route.connection.id).toBe(connection.id);
	});

	it("没有适配器 → unavailable,话里带 adapterKey", () => {
		const route = routeConnection(adapters, connectionOf("matrix", "matrix"));
		expect(route).toMatchObject({ ok: false, code: "unavailable" });
		expect(route.ok ? "" : route.message).toBe("no platform adapter for matrix");
	});

	it("设置过不了适配器的规则 → not_configured + 逐条原因", () => {
		const route = routeConnection(adapters, connectionOf("webhook", "generic", { url: 1 }));
		expect(route).toMatchObject({ ok: false, code: "not_configured" });
		if (route.ok) return;
		expect(route.message).toContain("连接设置不合法");
		expect(route.message).toContain("url");
		expect(route.issues?.[0]?.path).toEqual(["url"]);
	});
});
