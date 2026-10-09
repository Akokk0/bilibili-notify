import type { Connection, Logger, PlatformAdapter } from "@bilibili-notify/internal";
import { ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ConfigStore } from "../../config/store.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import { createTargetDispatcher } from "../../push/target-dispatcher.js";
import { createLinkReplySender } from "../link-reply.js";

/**
 * 链接回复的接线:群里贴链接 → 回复经**派发器**的 `sendToAddress` 到来源群,不再自己查连接、找适配器。
 * 零件(链接解析、派发器)各自的单测证明不了这一根线真接上了 —— 这里用真派发器 + 假适配器走一遍。
 */

const LOGGER: Logger = { info() {}, warn() {}, error() {}, debug() {} };
const PAYLOAD = { kind: "text", text: "卡片" } as const;

function connection(over: Record<string, unknown> = {}): Connection {
	return {
		id: "conn-1",
		name: "bot",
		kind: "direct",
		connector: "http",
		platform: "onebot",
		enabled: true,
		config: {},
		...over,
	} as unknown as Connection;
}

function setup(conn: Connection = connection()) {
	const send = vi.fn(async () => ok({ latencyMs: 5 }));
	const adapter: PlatformAdapter = {
		platforms: ["onebot"],
		isAvailable: () => true,
		send,
		probe: async () => ok({ latencyMs: 1 }),
	};
	const dispatcher = createTargetDispatcher({
		store: { getConnections: () => [conn], getTargets: () => [] } as unknown as ConfigStore,
		adapters: createPlatformAdapterRegistry([adapter]),
		logger: LOGGER,
	});
	return { send, sender: createLinkReplySender({ sendToAddress: dispatcher.sendToAddress }) };
}

describe("createLinkReplySender", () => {
	it("回到来源群:适配器收到群会话目标,地址是群号,平台与连接取自那条连接", async () => {
		const { send, sender } = setup();

		const result = await sender({ connectionId: "conn-1", groupId: "98765" }, PAYLOAD);

		expect(result).toEqual({ ok: true, latencyMs: 5 });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ id: "conn-1" }),
			expect.objectContaining({
				kind: "session",
				scope: "group",
				address: "98765",
				platform: "onebot",
				connectionId: "conn-1",
			}),
			PAYLOAD,
		);
	});

	it("连接不在了 → not_found 结果,不抛、不发", async () => {
		const { send, sender } = setup();
		const result = await sender({ connectionId: "ghost", groupId: "1" }, PAYLOAD);
		expect(result).toMatchObject({ ok: false, code: "not_found" });
		expect(send).not.toHaveBeenCalled();
	});

	it("连接被停用 → not_configured(从前不看启停,现在与出口咽喉一致)", async () => {
		const { send, sender } = setup(connection({ enabled: false }));
		const result = await sender({ connectionId: "conn-1", groupId: "1" }, PAYLOAD);
		expect(result).toMatchObject({ ok: false, code: "not_configured" });
		expect(send).not.toHaveBeenCalled();
	});
});
