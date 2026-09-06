import { describe, expect, it } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createDevRegistry } from "../registry.js";
import { busEventScenarios } from "../scenarios/bus-events.js";

/**
 * A5:引擎错误 / 登录失效 / 登录恢复 —— 直接往 MessageBus 上**发射**(不是转发,不碰
 * 「bus 与别的通道之间不写转发器」那条铁律)。消费方都是真的:主人私聊、右上角告警、
 * 引擎停摆与复位。
 */

function setup() {
	const bus = createNodeMessageBus();
	const seen: Array<[string, unknown[]]> = [];
	bus.on("engine-error", (source, message) => seen.push(["engine-error", [source, message]]));
	bus.on("auth-lost", () => seen.push(["auth-lost", []]));
	bus.on("auth-restored", () => seen.push(["auth-restored", []]));
	const reg = createDevRegistry(busEventScenarios({ bus }));
	return { reg, seen };
}

describe("总线事件场景", () => {
	it("engine.error:来源枚举 + 正文,原样发射", async () => {
		const { reg, seen } = setup();
		const res = await reg.run("engine.error", { source: "dynamic-engine", message: "假的炸了" });
		expect(seen).toEqual([["engine-error", ["dynamic-engine", "假的炸了"]]]);
		expect(res.summary).toContain("dynamic-engine");
	});

	it("engine.error 默认值:live-engine + 一句看得出是假的话", async () => {
		const { reg, seen } = setup();
		await reg.run("engine.error", {});
		expect(seen[0]?.[1][0]).toBe("live-engine");
		expect(String(seen[0]?.[1][1])).toContain("devtools");
	});

	it("auth.lost / auth.restored 各发一枪;说明里写明引擎会真的停 / 复位", async () => {
		const { reg, seen } = setup();
		await reg.run("auth.lost", {});
		await reg.run("auth.restored", {});
		expect(seen.map((s) => s[0])).toEqual(["auth-lost", "auth-restored"]);
		const lost = reg.list().find((d) => d.id === "auth.lost");
		expect(lost?.desc).toMatch(/引擎/);
	});
});
