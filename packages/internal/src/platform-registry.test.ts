/**
 * 平台注册表与它的两份**投影**。
 *
 * `WEBHOOK_PLATFORMS` 与 `INBOUND_CAPABLE_PLATFORMS` 本该直接从注册表算出来,写成
 * 手打的元组只有一个原因:`z.enum` 与 `LinkSourcePlatform` 都要求可枚举的字面量元组,
 * `.filter()` 出来的数组给不出那个类型。
 *
 * 代价就是它们会漂 —— 注册表里加一档走 webhook 的新平台、忘了往元组里补一格,
 * 连接照样存得下、面板照样画得出,只有「它算不算 webhook 那一族」在两处说得不一样。
 * 这两条用例把两边钉在一起:任何一边单独动都会红。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	CONNECTION_PLATFORMS,
	DIRECT_CONNECTORS,
	INBOUND_CAPABLE_PLATFORMS,
	PLATFORM_REGISTRY,
	WEBHOOK_PLATFORMS,
} from "./constants";

const platformsWhere = (pick: (p: (typeof CONNECTION_PLATFORMS)[number]) => boolean) =>
	CONNECTION_PLATFORMS.filter(pick).sort();

describe("注册表的投影", () => {
	it("WEBHOOK_PLATFORMS 就是注册表里默认走 webhook 连的那些", () => {
		expect([...WEBHOOK_PLATFORMS].sort()).toEqual(
			platformsWhere((p) => PLATFORM_REGISTRY[p].connectors[0] === "webhook"),
		);
	});

	it("INBOUND_CAPABLE_PLATFORMS 就是注册表里 inbound 为真的那些", () => {
		expect([...INBOUND_CAPABLE_PLATFORMS].sort()).toEqual(
			platformsWhere((p) => PLATFORM_REGISTRY[p].inbound),
		);
	});
});

describe("注册表自身", () => {
	it("每个平台都至少有一个连接器,而且都是认得的连法", () => {
		// `connectors[0]` 是「默认走哪个连接器」的答案,空数组会让 defaultConnectorFor
		// 悄悄回 undefined —— 新建连接拿到一个没有 connector 的壳,schema 才报错。
		for (const p of CONNECTION_PLATFORMS) {
			const connectors = PLATFORM_REGISTRY[p].connectors;
			expect(connectors.length).toBeGreaterThan(0);
			for (const c of connectors) {
				expect(DIRECT_CONNECTORS).toContain(c);
			}
		}
	});

	it("会话目标的平台要给得出会话种类,单向终点的只有一档", () => {
		for (const p of CONNECTION_PLATFORMS) {
			const { targetKind, scopes } = PLATFORM_REGISTRY[p];
			expect(scopes.length).toBeGreaterThan(0);
			if (targetKind === "endpoint") expect(scopes.length).toBe(1);
		}
	});
});
