/**
 * 「这条 token 是哪条桥接入的」。
 *
 * 这是**未鉴权的外来输入**第一次碰到配置,所以两件事都不能马虎:比对要恒定时间(别让
 * 攻击者按响应快慢逐字节猜 token),以及**只认桥那一支** —— onebot 的 accessToken、官机
 * 的 appSecret 都住在同一份连接表里,它们不是桥凭据。
 */

import type { Connection } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { resolveBridgeToken } from "../tokens.js";

function bridge(id: string, token: string, enabled = true): Connection {
	return {
		id,
		name: `桥 ${id}`,
		enabled,
		kind: "bridge",
		connector: "bridge",
		config: { token, bridgeKind: "koishi" },
	} as Connection;
}

function direct(id: string, token: string): Connection {
	return {
		id,
		name: "onebot",
		enabled: true,
		kind: "direct",
		platform: "onebot",
		connector: "ws",
		config: { transport: "ws", url: "ws://127.0.0.1:3001", accessToken: token, token },
	} as unknown as Connection;
}

describe("resolveBridgeToken", () => {
	it("对上了就给出那条接入的 id", () => {
		expect(resolveBridgeToken([bridge("a", "s3cret")], "s3cret")).toBe("a");
	});

	it("对不上就是 null", () => {
		expect(resolveBridgeToken([bridge("a", "s3cret")], "guess")).toBeNull();
	});

	it("长度不同也只是不匹配,不炸 —— timingSafeEqual 对不等长会抛", () => {
		expect(resolveBridgeToken([bridge("a", "s3cret")], "x")).toBeNull();
		expect(resolveBridgeToken([bridge("a", "s3cret")], "s3cret-and-then-some")).toBeNull();
	});

	it("**停用的接入照样认得** —— 收不收是另一个问题(那边回 503,不是 401)", () => {
		expect(resolveBridgeToken([bridge("a", "s3cret", false)], "s3cret")).toBe("a");
	});

	it("**空 token 永远不匹配**:脱敏备份会把它抹成空串,恢复回来的那条不能变成谁都能连", () => {
		expect(resolveBridgeToken([bridge("a", "")], "")).toBeNull();
	});

	it("直连的凭据不算数 —— onebot 的 accessToken 不是桥 token", () => {
		expect(resolveBridgeToken([direct("d", "s3cret")], "s3cret")).toBeNull();
	});

	it("多条接入里挑对的那条", () => {
		const list = [bridge("a", "aaa"), bridge("b", "bbb"), bridge("c", "ccc")];
		expect(resolveBridgeToken(list, "bbb")).toBe("b");
	});

	it("撞了同一个 token(只可能是手改的配置)→ 取表里第一条,别看运气", () => {
		expect(resolveBridgeToken([bridge("a", "same"), bridge("b", "same")], "same")).toBe("a");
	});
});
