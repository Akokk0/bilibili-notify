/**
 * 运行时单测 — `types/domain.ts` 的工厂函数。
 *
 * 守护契约:`newId()` 必须产出后端 `z.uuid()` 能通过的合法 RFC 4122 v4 UUID。
 * 回归背景:旧实现优先 `crypto.randomUUID()`,但该 API 仅在 secure context
 * (HTTPS / localhost)可用 —— 独立端 docker 经 `http://<内网IP>:8787` 访问时
 * 它是 undefined,旧 fallback 产出非法格式(4 段任意长 hex),后端 z.uuid()
 * 拒 → 添加订阅 / 适配器 / 目标全部 400。
 */

import { describe, expect, it } from "vitest";
import { newId } from "./domain";

/** RFC 4122 v4:版本位固定 `4`,variant 位固定 `[89ab]`。后端 z.uuid() 等价校验。 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("newId", () => {
	it("恒产出合法 RFC 4122 v4 UUID(走 crypto.getRandomValues,不依赖 secure context)", () => {
		// 多跑几轮覆盖随机位:版本 / variant 位被钉死,其余字节随机也必须始终合规。
		for (let i = 0; i < 500; i++) {
			expect(newId()).toMatch(UUID_V4_RE);
		}
	});

	it("不重复(随机性 sanity)", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 1000; i++) seen.add(newId());
		expect(seen.size).toBe(1000);
	});

	/**
	 * 核心回归守护:即使 `crypto.randomUUID` 完全不存在(= 非 secure context,
	 * docker 经 `http://<内网IP>:8787` 访问的真实形态),`newId()` 仍必须产出合法
	 * UUID。旧实现在此场景会落进 4 段任意长 hex 的非法 fallback → 后端 z.uuid()
	 * 拒 → 添加订阅 / 适配器 / 目标全 400。新实现根本不引用 `crypto.randomUUID`,
	 * 这条用例把"不依赖 secure-context-only API"这个契约钉死。
	 *
	 * `crypto.randomUUID` 是 `Crypto.prototype` 上 `configurable: true` 的方法,
	 * 可用 own-property 覆写成 undefined 模拟其缺席;finally 还原以免污染其它用例。
	 */
	it("crypto.randomUUID 缺席(非 secure context)时仍产出合法 v4 UUID", () => {
		const proto = Object.getPrototypeOf(crypto) as object;
		const original = Object.getOwnPropertyDescriptor(proto, "randomUUID");
		// own-property 覆写,遮蔽原型上的方法;模拟非 secure context 下它是 undefined。
		Object.defineProperty(crypto, "randomUUID", {
			value: undefined,
			configurable: true,
			writable: true,
		});
		try {
			expect((crypto as { randomUUID?: unknown }).randomUUID).toBeUndefined();
			for (let i = 0; i < 200; i++) {
				expect(newId()).toMatch(UUID_V4_RE);
			}
		} finally {
			// 删掉 own-property,露出原型上的原方法,还原环境。
			delete (crypto as { randomUUID?: unknown }).randomUUID;
			// 兜底:若运行时 randomUUID 本就是 crypto 实例自有属性,补回原描述符。
			if (original && !Object.getOwnPropertyDescriptor(crypto, "randomUUID")) {
				const onProto = Object.getOwnPropertyDescriptor(proto, "randomUUID");
				if (!onProto) Object.defineProperty(crypto, "randomUUID", original);
			}
		}
		// 还原后 randomUUID 必须重新可用,确认没污染后续用例。
		expect(typeof (crypto as { randomUUID?: unknown }).randomUUID).toBe("function");
	});
});
