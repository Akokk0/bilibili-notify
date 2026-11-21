import type { Connection, NotificationPayload, PushTarget } from "@bilibili-notify/internal";
import { ok } from "@bilibili-notify/internal";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { fakeAdapterContext } from "../../__tests__/support/adapter-ctx.js";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import type { ConfigStore } from "../../config/store.js";
import { createOnebotAdapter } from "../../platforms/onebot.js";
import { createQQOfficialAdapter } from "../../platforms/qq-official.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import { createTargetDispatcher } from "../../push/target-dispatcher.js";
import { createTargetTester } from "../../push/target-tester.js";
import { createNodeServiceContext } from "../../runtime/service-context.js";
import { createTargetsRoute } from "../targets.js";
import type { RouteDeps } from "../types.js";

const ID = "33333333-3333-4333-8333-333333333333";
afterEach(() => vi.useRealTimers());

async function harness(platform: "onebot" | "qq-official" = "onebot") {
	const serviceCtx = createNodeServiceContext({ name: "capability-test", level: "silent" });
	const adapter =
		platform === "qq-official"
			? createQQOfficialAdapter({ logger: console, serviceCtx, locale: fixedLocale() })
			: createOnebotAdapter({ logger: console, serviceCtx });
	const context = fakeAdapterContext();
	const registry = createPlatformAdapterRegistry();
	await registry.register(adapter, context.ctx);
	const connection = {
		id: "a",
		adapterKey: platform,
		platform,
		enabled: true,
		settings:
			platform === "qq-official"
				? { appId: "app", appSecret: "fixture", botType: "public", sandbox: false }
				: { transport: "ws", url: "ws://127.0.0.1:5700", retryIntervalMs: 0 },
	} as unknown as Connection;
	const target = {
		id: ID,
		name: "group",
		kind: "session",
		connectionId: "a",
		scope: "group",
		address: "123",
		enabled: true,
	} as PushTarget;
	const store = {
		getConnection: () => connection,
		getTargets: () => [target],
	} as unknown as ConfigStore;
	const sent: NotificationPayload[] = [];
	const dispatcher = createTargetDispatcher({
		store,
		adapters: registry,
		logger: console,
		interceptSend: ({ payload }) => {
			sent.push(payload);
			return ok({ latencyMs: 7 });
		},
	});
	const tests = createTargetTester({ store, dispatcher });
	const app = createTargetsRoute({
		store,
		runtime: { pipeline: { targetTests: tests }, serviceCtx: { logger: console } },
	} as unknown as RouteDeps);
	const post = async (capability: string, extra = {}) =>
		app.request(`/${ID}/test`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ capability, ...extra }),
		});
	return {
		app,
		post,
		sent,
		tests,
		target,
		connection,
		dispose: () => {
			tests.dispose();
			context.abort();
			void serviceCtx.dispose();
		},
	};
}

it("能力测试发送真实语音和多图载荷；未确认的艾特全体不发送", async () => {
	const h = await harness();
	try {
		expect(await (await h.post("audio")).json()).toMatchObject({ ok: true, latencyMs: 7 });
		expect(h.sent[0]).toMatchObject({ kind: "audio", audio: { mime: "audio/silk" } });
		const voice = h.sent[0];
		if (voice?.kind !== "audio") throw new Error("expected audio");
		expect(voice.audio.buffer.subarray(1, 10).toString()).toBe("#!SILK_V3");
		expect(await (await h.post("imageGroup")).json()).toMatchObject({ ok: true });
		expect(h.sent[1]).toMatchObject({
			kind: "composite",
			segments: [{ kind: "image" }, { kind: "image" }],
		});
		expect(await (await h.post("atAll")).json()).toMatchObject({ ok: false, code: "invalid" });
		expect(h.sent).toHaveLength(2);
	} finally {
		h.dispose();
	}
});

it("QQ 官方机器人群接收测试能发送无链接的提示并收到同一验证码", async () => {
	const h = await harness("qq-official");
	try {
		const response = (await (await h.post("inbound")).json()) as {
			ok: boolean;
			reception: { id: string; reply: string };
		};
		expect(response.ok).toBe(true);
		const { id, reply } = response.reception;
		expect(h.sent[0]).toMatchObject({
			kind: "text",
			text: expect.not.stringMatching(/https?:\/\/|bn\.invalid/i),
		});
		expect(reply).toMatch(/^BN-[a-f0-9]+$/);
		expect(h.sent[0]).toMatchObject({ text: expect.stringContaining(reply) });
		expect(
			h.tests.receive(
				"group",
				{ address: "123", text: reply },
				{ connectionId: "a", platform: "qq-official" },
			),
		).toBe(true);
		expect(await (await h.app.request(`/${ID}/test/${id}`)).json()).toMatchObject({
			state: "received",
		});
	} finally {
		h.dispose();
	}
});

it("接收测试只认当前连接和会话的准确回传，发送本身不算收到", async () => {
	const h = await harness();
	try {
		const response = (await (await h.post("inbound")).json()) as {
			ok: boolean;
			reception: { id: string; reply: string; expiresAt: string };
		};
		expect(response).toMatchObject({ ok: true, reception: { state: "pending" } });
		const test = response.reception;
		// A bridge subscribed to with-links only forwards group replies containing a URL.
		expect(test.reply).toMatch(/^https?:\/\/\S+$/);
		const path = `/${ID}/test/${test.id}`;
		expect(h.sent.at(-1)).toMatchObject({
			kind: "text",
			text: expect.stringContaining(test.reply),
		});
		expect(
			h.tests.receive(
				"group",
				{ address: "other", text: test.reply },
				{ connectionId: "a", platform: "onebot" },
			),
		).toBe(false);
		expect(
			h.tests.receive(
				"group",
				{ address: "123", text: test.reply },
				{ connectionId: "other", platform: "onebot" },
			),
		).toBe(false);
		expect(
			h.tests.receive(
				"group",
				{ address: "123", text: `quoted: ${test.reply}` },
				{ connectionId: "a", platform: "onebot" },
			),
		).toBe(false);
		expect(((await (await h.app.request(path)).json()) as { state: string }).state).toBe("pending");
		expect(
			h.tests.receive(
				"group",
				{ address: "123", text: test.reply },
				{ connectionId: "a", platform: "onebot" },
			),
		).toBe(true);
		expect(((await (await h.app.request(path)).json()) as { state: string }).state).toBe(
			"received",
		);
	} finally {
		h.dispose();
	}
});

it.each(["cancel", "expired", "disabled", "changed", "dispose", "new"] as const)(
	"接收测试 %s 后旧码不能再通过",
	async (action) => {
		const h = await harness();
		try {
			const { reception: test } = (await (await h.post("inbound")).json()) as {
				reception: { id: string; reply: string; expiresAt: string };
			};
			const path = `/${ID}/test/${test.id}`;
			if (action === "cancel")
				expect((await h.app.request(path, { method: "DELETE" })).status).toBe(204);
			if (action === "expired") {
				vi.useFakeTimers();
				vi.setSystemTime(new Date(test.expiresAt).getTime() + 1);
			}
			if (action === "disabled") h.connection.enabled = false;
			if (action === "changed" && h.target.kind === "session") h.target.address = "456";
			if (action === "dispose") h.tests.dispose();
			if (action === "new") {
				const next = (await (await h.post("inbound")).json()) as { reception: { reply: string } };
				expect(next.reception.reply).not.toBe(test.reply);
			}
			expect(
				h.tests.receive(
					"group",
					{ address: "123", text: test.reply },
					{ connectionId: "a", platform: "onebot" },
				),
			).toBe(false);
			const result = await h.app.request(path);
			if (["cancel", "dispose", "new"].includes(action)) expect(result.status).toBe(404);
			else
				expect(await result.json()).toMatchObject({
					state: action === "expired" ? "expired" : "cancelled",
				});
		} finally {
			h.dispose();
		}
	},
);
