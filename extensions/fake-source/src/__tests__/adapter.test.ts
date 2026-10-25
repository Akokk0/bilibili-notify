/**
 * 假平台适配器:逐成员走 `PlatformAdapter`,让推送守卫③有一个真包可驱动。
 *
 * 硬约束是 `start` 不建连接、不出网、不起定时器(九条 e2e 都装着假源)—— 这里也钉:
 * 起一个适配器只读连接名单、订一个变更,别的什么都不做。
 */

import { readFile } from "node:fs/promises";
import type { ExtensionBlock, NotificationPayload } from "@bilibili-notify/extension";
import { describe, expect, it } from "vite-plus/test";
import { createFakeAdapter, FakeConnectionSettingsSchema } from "../adapter.js";
import { bootFakeSource, fakeAdapterContext, fakeConnection } from "./harness.js";

const SIGNAL = new AbortController().signal;

const CHAT_GROUP = {
	kind: "session" as const,
	scope: "group" as const,
	address: "g-1",
};

function text(value: string): NotificationPayload {
	return { kind: "text", text: value };
}

/** 清单 `contributes.push.settingsFields` 原样。 */
async function manifestFields(): Promise<
	{ key: string; type: string; default?: unknown; label: string }[]
> {
	const manifest = JSON.parse(
		await readFile(new URL("../../extension.json", import.meta.url), "utf8"),
	) as { contributes: { push: { settingsFields: never[] } } };
	return manifest.contributes.push.settingsFields;
}

function started(connections = [fakeConnection("c-1")]) {
	let changes = 0;
	const adapter = createFakeAdapter({ changed: () => (changes += 1) });
	const host = fakeAdapterContext(connections);
	adapter.def.start(host.ctx);
	return { adapter, host, changes: () => changes };
}

describe("连接候选", () => {
	it("两个模板候选:会话型 fake-chat 带群、私聊、频道三种,端点型 fake-hook;都可反复用", async () => {
		const { adapter } = started();
		const found = await adapter.def.listConnectionCandidates(SIGNAL);

		expect(found.map((one) => one.platform.platform)).toEqual(["fake-chat", "fake-hook"]);
		const [chat, hook] = found;
		expect(chat?.platform).toMatchObject({
			targetKind: "session",
			scopes: ["group", "private", "channel"],
		});
		expect(hook?.platform).toMatchObject({ targetKind: "endpoint" });
		for (const one of found) {
			expect(one.boundConnectionId).toBeUndefined();
			expect(one.name.length).toBeGreaterThan(0);
			// 候选带的设置过得了适配器自己的 schema。
			expect(FakeConnectionSettingsSchema.safeParse(one.settings).success).toBe(true);
		}
	});
});

describe("设置 schema 与清单", () => {
	it("两格逐格对表:键、类型、默认值", async () => {
		const fields = await manifestFields();
		expect(fields.map((f) => [f.key, f.type, f.default])).toEqual([
			["atAll", "boolean", false],
			["inboundFrom", "string", ""],
		]);
		// zod 一侧:空对象解出来就是清单的默认值。
		expect(FakeConnectionSettingsSchema.parse({})).toEqual({ atAll: false, inboundFrom: "" });
		expect(FakeConnectionSettingsSchema.safeParse({ atAll: "yes" }).success).toBe(false);
		expect(FakeConnectionSettingsSchema.safeParse({ inboundFrom: 3 }).success).toBe(false);
	});

	it("注册上去的 def 带着这份 schema", () => {
		const fake = bootFakeSource();
		expect(fake.adapter().settingsSchema).toBe(FakeConnectionSettingsSchema);
	});
});

describe("能力三态", () => {
	it("atAll 与 inbound 随这条连接的设置变,nativeShare 恒是「还不知道」", () => {
		const { adapter } = started();
		const open = fakeConnection("a", { settings: { atAll: true, inboundFrom: "owner" } });
		const closed = fakeConnection("b", { settings: { atAll: false, inboundFrom: "" } });

		const a = adapter.def.capabilities?.(open);
		expect(a?.atAll.state).toBe("supported");
		expect(a?.inbound.state).toBe("supported");
		expect(a?.nativeShare.state).toBe("unknown");

		const b = adapter.def.capabilities?.(closed);
		expect(b?.atAll.state).toBe("unsupported");
		expect(b?.inbound.state).toBe("unsupported");
		expect(b?.nativeShare.state).toBe("unknown");
	});

	it("probeCapabilities 答同样的 atAll / inbound,nativeShare 答「不支持」并给一句理由", async () => {
		const { adapter } = started();
		const open = fakeConnection("a", { settings: { atAll: true, inboundFrom: "owner" } });
		const probed = await adapter.def.probeCapabilities?.(open);

		expect(probed?.atAll.state).toBe("supported");
		expect(probed?.inbound.state).toBe("supported");
		expect(probed?.nativeShare).toMatchObject({ state: "unsupported" });
		const share = probed?.nativeShare;
		expect(share?.state === "unsupported" && share.reason.length > 0).toBe(true);
	});
});

describe("start / stop 与对账", () => {
	it("start 先对一次账再订变更;不起定时器、不出网", () => {
		const { adapter, host, changes } = started([fakeConnection("a"), fakeConnection("b")]);
		expect(adapter.connectionCount()).toBe(2);
		expect(host.listenerCount()).toBe(1);
		// 头一次对账是 start 自己的事,不算「变了」,视图本来就是现取的。
		expect(changes()).toBe(0);
	});

	it("同一份连接表再来一次是空操作(不喊视图刷新),变了才喊", () => {
		const { adapter, host, changes } = started([fakeConnection("a")]);

		host.setConnections([fakeConnection("a")]);
		host.setConnections([fakeConnection("a")]);
		expect(changes()).toBe(0);
		expect(adapter.connectionCount()).toBe(1);

		host.setConnections([fakeConnection("a"), fakeConnection("b", { platform: "fake-hook" })]);
		expect(changes()).toBe(1);
		expect(adapter.connectionCount()).toBe(2);

		// 开关翻了也算变。
		host.setConnections([
			fakeConnection("a", { enabled: false }),
			fakeConnection("b", { platform: "fake-hook" }),
		]);
		expect(changes()).toBe(2);

		host.setConnections([]);
		expect(changes()).toBe(3);
		expect(adapter.connectionCount()).toBe(0);
	});

	it("stop 清表、丢上下文,幂等", () => {
		const { adapter } = started([fakeConnection("a")]);
		adapter.def.stop();
		adapter.def.stop();
		expect(adapter.connectionCount()).toBe(0);
		expect(adapter.context()).toBeUndefined();
	});

	it("拓展里:连接一动视图就多一块「管着几条连接」,晚来的连接 start 时已经读到", () => {
		const fake = bootFakeSource([], { connections: [fakeConnection("a"), fakeConnection("b")] });
		const before = fake.statusChanges();
		fake.setConnections([fakeConnection("a"), fakeConnection("b"), fakeConnection("c")]);
		expect(fake.statusChanges()).toBe(before + 1);
		expect(JSON.stringify(fake.view().page)).toContain("3 条连接");
	});
});

describe("isAvailable / probe", () => {
	it("会话去向要地址非空才可用,端点去向恒可用", async () => {
		const { adapter } = started();
		const conn = fakeConnection("a");

		expect(adapter.def.isAvailable(conn, CHAT_GROUP)).toBe(true);
		expect(adapter.def.isAvailable(conn, { ...CHAT_GROUP, address: "" })).toBe(false);
		expect(adapter.def.isAvailable(conn, { kind: "endpoint", id: "e-1", name: "钩子" })).toBe(true);
		expect(await adapter.def.probe(conn)).toMatchObject({ ok: true });
	});
});

describe("send", () => {
	it("每次发送记一条:连接、平台、去向、载荷各段的种类与文字", async () => {
		const { adapter } = started();
		const conn = fakeConnection("c-9", { platform: "fake-chat" });

		const result = await adapter.def.send(
			conn,
			{ ...CHAT_GROUP, parentAddress: "guild-1" },
			{ kind: "composite", segments: [{ kind: "at-all" }, { kind: "text", text: "你好" }] },
		);
		expect(result).toMatchObject({ ok: true });
		await adapter.def.send(conn, { kind: "endpoint", id: "e-1", name: "钩子" }, text("第二条"));

		expect(adapter.sent()).toEqual([
			{
				connectionId: "c-9",
				platform: "fake-chat",
				destination: { kind: "session", scope: "group", address: "g-1", parentAddress: "guild-1" },
				segments: [{ kind: "at-all" }, { kind: "text", text: "你好" }],
			},
			{
				connectionId: "c-9",
				platform: "fake-chat",
				destination: { kind: "endpoint", endpointId: "e-1" },
				segments: [{ kind: "text", text: "第二条" }],
			},
		]);
	});

	it("文字过长要截短", async () => {
		const { adapter } = started();
		await adapter.def.send(fakeConnection("a"), CHAT_GROUP, text("长".repeat(500)));
		const shown = adapter.sent()[0]?.segments[0]?.text ?? "";
		expect(shown.length).toBeLessThan(500);
		expect(shown.startsWith("长")).toBe(true);
	});

	it("只用递进来的连接,不查自己的表:表里没有的连接照样记", async () => {
		const { adapter } = started([]);
		expect(adapter.connectionCount()).toBe(0);
		const result = await adapter.def.send(fakeConnection("not-in-table"), CHAT_GROUP, text("x"));
		expect(result).toMatchObject({ ok: true });
		expect(adapter.sent().map((one) => one.connectionId)).toEqual(["not-in-table"]);
	});

	it("记账环最多 50 条,满了丢最旧的", async () => {
		const { adapter } = started();
		for (let i = 1; i <= 53; i += 1) {
			await adapter.def.send(fakeConnection("a"), CHAT_GROUP, text(`第 ${i} 条`));
		}
		const sent = adapter.sent();
		expect(sent).toHaveLength(50);
		expect(sent[0]?.segments[0]?.text).toBe("第 4 条");
		expect(sent.at(-1)?.segments[0]?.text).toBe("第 53 条");
	});

	it("视图上多出表格与「最近一条文字」提示,次序在原有各块之后", async () => {
		const fake = bootFakeSource([{ externalId: "p", enabled: true }]);
		const before = fake.view().page?.map((b) => b.type) ?? [];
		await fake.adapter().send(fakeConnection("c-1"), CHAT_GROUP, text("这是最近的一条"));
		const page = fake.view().page ?? [];

		expect(page.slice(0, before.length).map((b) => b.type)).toEqual(before);
		const table = page.find(
			(b): b is Extract<ExtensionBlock, { type: "table" }> => b.type === "table",
		);
		expect(table?.rows).toHaveLength(1);
		expect(JSON.stringify(page.at(-1))).toContain("这是最近的一条");
	});
});

describe("注册", () => {
	it("运行时的 def 上故意带着三个不开的成员,给推送守卫③证明宿主会摘掉 / 覆盖", () => {
		const def = bootFakeSource().adapter() as unknown as Record<string, unknown>;
		expect(def.adapterKey).toBe("onebot");
		expect(typeof def.listAddressCandidates).toBe("function");
		expect(typeof def.connectionAuth).toBe("object");
	});
});
