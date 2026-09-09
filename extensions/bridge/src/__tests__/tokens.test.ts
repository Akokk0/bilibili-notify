/**
 * 「这条 token 是哪条桥接入的」。
 *
 * 这是**未鉴权的外来输入**第一次碰到配置,所以比对不能马虎:要恒定时间,别让攻击者按
 * 响应快慢逐字节猜 token。
 *
 * ⛔ 「别人的凭据不算数」(onebot 的 accessToken、官机的 appSecret 住在同一份连接表里)
 * 从前要在这一层自己判,现在**判不着了** —— 宿主只把属于这个拓展的连接交过来
 * (ADR-0012 决策 30),那条守卫在 `extensions/__tests__/context-grants.test.ts`。
 */

import type { ExtensionConnectionView } from "@bilibili-notify/extension";
import { describe, expect, it } from "vite-plus/test";
import type { BridgeConnectionConfig } from "../config.js";
import { resolveBridgeToken } from "../tokens.js";

function bridge(
	id: string,
	token: string,
	enabled = true,
): ExtensionConnectionView<BridgeConnectionConfig> {
	return { id, name: `桥 ${id}`, enabled, config: { token, bridgeKind: "koishi" } };
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

	it("多条接入里挑对的那条", () => {
		const list = [bridge("a", "aaa"), bridge("b", "bbb"), bridge("c", "ccc")];
		expect(resolveBridgeToken(list, "bbb")).toBe("b");
	});

	it("撞了同一个 token(只可能是手改的配置)→ 取表里第一条,别看运气", () => {
		expect(resolveBridgeToken([bridge("a", "same"), bridge("b", "same")], "same")).toBe("a");
	});
});
