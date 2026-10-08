import type { ConnectionView } from "@bilibili-notify/contract";
import { ConnectionSchema } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import {
	clearedCredentials,
	connectionPatch,
	credentialCellsOf,
	displayConnection,
	savedMasksOf,
} from "../connection-credentials";
import { switchOnebotTransport } from "../domain";

/**
 * 连接编辑走 PATCH(ADR-0021 决策 44):没动过的凭据格不进 PATCH(带遮挡是 400,不带 = 保留);换新的发明文;
 * 点「换一份」后留空 = 清空;切 OneBot 连法时消失的键交 `null`。每条断言的是**发出去的请求体**。
 */
const ID = "11111111-1111-4111-8111-111111111111";
const MASK = "••••••••";
const base = { id: ID, name: "n", enabled: true, kind: "direct" } as const;

const onebotView = {
	...base,
	platform: "onebot",
	connector: "http",
	config: {
		transport: "http",
		baseUrl: "http://127.0.0.1:3000",
		protocolVersion: "v11",
		headers: {},
		timeoutMs: 15_000,
		imageMinTimeoutMs: 30_000,
		mergeForwardMinTimeoutMs: 60_000,
		retryTimes: 0,
		retryIntervalMs: 1_000,
		accessToken: { masked: "abcd••••••••wxyz" },
	},
} as unknown as ConnectionView;
const webhookView = {
	...base,
	platform: "dingtalk",
	connector: "webhook",
	config: { url: { masked: "http••••••••=tok" }, secret: { masked: MASK }, headers: {} },
} as unknown as ConnectionView;
const qqView = {
	...base,
	platform: "qq-official",
	connector: "ws",
	config: {
		appId: "1",
		appSecret: { masked: MASK },
		sandbox: false,
		botType: "public",
		logReconnects: false,
	},
} as unknown as ConnectionView;

const cfgOf = (view: ConnectionView) =>
	(view as unknown as { config: Record<string, unknown> }).config;

/** 打开编辑 → 草稿、基线、已存着的遮挡。 */
function open(view: ConnectionView) {
	const baseConn = displayConnection(view);
	return { base: baseConn, draft: clearedCredentials(baseConn), saved: savedMasksOf(baseConn) };
}

describe("displayConnection / savedMasksOf / clearedCredentials", () => {
	it("下发的遮挡变成它那串字;草稿里凭据格清空,已存着的另记", () => {
		const { base: b, draft, saved } = open(onebotView);
		expect((b.config as Record<string, unknown>).accessToken).toBe("abcd••••••••wxyz");
		expect(saved).toEqual({ "config.accessToken": "abcd••••••••wxyz" });
		expect(draft.config).not.toHaveProperty("accessToken");
		expect(open(qqView).draft.config).toMatchObject({ appSecret: "" });
	});

	it("没配的凭据格不算已存着", () => {
		const view = {
			...onebotView,
			config: { ...cfgOf(onebotView), accessToken: undefined },
		} as unknown as ConnectionView;
		expect(open(view).saved).toEqual({});
	});

	it("webhook 的地址与 secret、官机 appSecret、OneBot token 各是凭据格;拓展连接没有", () => {
		expect(credentialCellsOf(open(webhookView).base).map((c) => c.key)).toEqual(["url", "secret"]);
		expect(credentialCellsOf(open(qqView).base).map((c) => c.key)).toEqual(["appSecret"]);
		expect(credentialCellsOf(open(onebotView).base).map((c) => c.key)).toEqual(["accessToken"]);
		const ext = { ...base, kind: "extension", extensionId: "bridge", platform: "qq", config: {} };
		expect(credentialCellsOf(ext as never)).toEqual([]);
	});
});

describe("connectionPatch — 发出去的请求体", () => {
	it("只改别的格:凭据格一个都不在(带遮挡是 400)", () => {
		const { base: b, draft, saved } = open(onebotView);
		const edited = { ...draft, name: "改名" };
		const patch = connectionPatch(edited, b, saved, {});
		expect(patch).toMatchObject({ name: "改名" });
		expect(patch.config).not.toHaveProperty("accessToken");
		expect(JSON.stringify(patch)).not.toContain("••");
	});

	it("webhook 只改名:地址与 secret 都不在", () => {
		const { base: b, draft, saved } = open(webhookView);
		const patch = connectionPatch({ ...draft, name: "x" }, b, saved, {});
		expect(patch.config).not.toHaveProperty("url");
		expect(patch.config).not.toHaveProperty("secret");
	});

	it("点了「换一份」并填了新值 → 发新明文", () => {
		const { base: b, draft, saved } = open(qqView);
		const edited = {
			...draft,
			config: { ...(draft.config as object), appSecret: "brand-new" },
		} as typeof draft;
		const patch = connectionPatch(edited, b, saved, { "config.appSecret": true });
		expect(patch.config).toMatchObject({ appSecret: "brand-new" });
	});

	it("点了「换一份」后留空:必填的交空串,可选的交 null", () => {
		const qq = open(qqView);
		expect(
			connectionPatch(qq.draft, qq.base, qq.saved, { "config.appSecret": true }).config,
		).toMatchObject({ appSecret: "" });
		const ob = open(onebotView);
		const patch = connectionPatch(ob.draft, ob.base, ob.saved, { "config.accessToken": true });
		expect(patch.config).toHaveProperty("accessToken", null);
		const hook = open(webhookView);
		const hp = connectionPatch(hook.draft, hook.base, hook.saved, { "config.secret": true });
		expect(hp.config).toHaveProperty("secret", null);
		expect(hp.config).not.toHaveProperty("url");
	});

	it("本来没配的凭据格:填了就发,没填就不提", () => {
		const view = {
			...onebotView,
			config: { ...cfgOf(onebotView), accessToken: undefined },
		} as unknown as ConnectionView;
		const { base: b, draft, saved } = open(view);
		const none = connectionPatch(draft, b, saved, {});
		expect(none.config).not.toHaveProperty("accessToken");
		const typed = {
			...draft,
			config: { ...(draft.config as object), accessToken: "tok" },
		} as typeof draft;
		expect(connectionPatch(typed, b, saved, {}).config).toMatchObject({ accessToken: "tok" });
	});

	it("切 OneBot 连法:上一档的残字段交 null,新连法的格与 connector 一起发,凭据不动", () => {
		const { base: b, draft, saved } = open(onebotView);
		const cfg = switchOnebotTransport(draft.config as never, "ws");
		const edited = { ...draft, connector: "ws", config: cfg } as typeof draft;
		const patch = connectionPatch(edited, b, saved, {});
		expect(patch).toMatchObject({ connector: "ws" });
		expect(patch.config).toMatchObject({
			transport: "ws",
			url: "ws://127.0.0.1:3001",
			baseUrl: null,
		});
		expect(patch.config).not.toHaveProperty("accessToken");
		// 合并进存着的那条之后能过 schema 的 strict(服务端 deepMerge 的语义)。
		const merged = { ...(onebotView as object), ...patch, config: {} } as Record<string, unknown>;
		const stored = { ...cfgOf(onebotView), accessToken: "real-token" };
		const nextConfig: Record<string, unknown> = { ...stored };
		for (const [k, v] of Object.entries(patch.config as Record<string, unknown>)) {
			if (v === null) delete nextConfig[k];
			else nextConfig[k] = v;
		}
		merged.config = nextConfig;
		expect(ConnectionSchema.safeParse(merged).success).toBe(true);
	});
});
