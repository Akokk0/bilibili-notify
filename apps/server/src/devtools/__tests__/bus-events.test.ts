import { describe, expect, it } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createDevRegistry } from "../registry.js";
import { busEventScenarios } from "../scenarios/bus-events.js";

/**
 * A5:推送链路错误直接往 MessageBus 上**发射**(不是转发,不碰
 * 「bus 与别的通道之间不写转发器」那条铁律)。消费方是真的:主人私聊、右上角告警。
 */

function setup() {
	const bus = createNodeMessageBus();
	const seen: Array<[string, unknown[]]> = [];
	bus.on("pipeline-error", ({ source, message }) =>
		seen.push(["pipeline-error", [source, message]]),
	);
	const reg = createDevRegistry(busEventScenarios({ bus }));
	return { reg, seen };
}

describe("总线事件场景", () => {
	it("pipeline.error:来源枚举 + 正文,原样发射", async () => {
		const { reg, seen } = setup();
		const res = await reg.run("pipeline.error", { source: "post-delivery", message: "假的炸了" });
		expect(seen).toEqual([["pipeline-error", ["post-delivery", "假的炸了"]]]);
		expect(res.summary).toContain("post-delivery");
	});

	it("pipeline.error 默认值:live-engine + 一句看得出是假的话", async () => {
		const { reg, seen } = setup();
		await reg.run("pipeline.error", {});
		expect(seen[0]?.[1][0]).toBe("live-engine");
		expect(String(seen[0]?.[1][1])).toContain("devtools");
	});
});
