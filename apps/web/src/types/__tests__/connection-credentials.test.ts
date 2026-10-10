import type { ConnectionView } from "@bilibili-notify/contract";
import { OnebotConnectionSettingsSchema } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/platform-snapshot";
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
const base = { id: ID, name: "n", enabled: true } as const;

const onebotView = {
	...base,
	adapterKey: "onebot",
	platform: "onebot",
	platformSnapshot: snapshotFor("onebot"),
	settings: {
		transport: "http",
		baseUrl: "http://127.0.0.1:3000",
		protocolVersion: "v11",
		headers: {},
		timeoutMs: 15_000,
		imageMinTimeoutMs: 30_000,
		mergeForwardMinTimeoutMs: 60_000,
		maxRetries: 0,
		retryIntervalMs: 1_000,
		accessToken: { masked: "abcd••••••••wxyz" },
	},
} as unknown as ConnectionView;
const webhookView = {
	...base,
	adapterKey: "webhook",
	platform: "dingtalk",
	platformSnapshot: snapshotFor("dingtalk"),
	settings: { url: { masked: "http••••••••=tok" }, secret: { masked: MASK }, headers: {} },
} as unknown as ConnectionView;
const qqView = {
	...base,
	adapterKey: "qq-official",
	platform: "qq-official",
	platformSnapshot: snapshotFor("qq-official"),
	settings: {
		appId: "1",
		appSecret: { masked: MASK },
		sandbox: false,
		botType: "public",
		logReconnects: false,
	},
} as unknown as ConnectionView;

const cfgOf = (view: ConnectionView) =>
	(view as unknown as { settings: Record<string, unknown> }).settings;

/** 打开编辑 → 草稿、基线、已存着的遮挡。 */
function open(view: ConnectionView) {
	const baseConn = displayConnection(view);
	return { base: baseConn, draft: clearedCredentials(baseConn), saved: savedMasksOf(baseConn) };
}

describe("displayConnection / savedMasksOf / clearedCredentials", () => {
	it("下发的遮挡变成它那串字;草稿里凭据格清空,已存着的另记", () => {
		const { base: b, draft, saved } = open(onebotView);
		expect((b.settings as Record<string, unknown>).accessToken).toBe("abcd••••••••wxyz");
		expect(saved).toEqual({ "settings.accessToken": "abcd••••••••wxyz" });
		expect(draft.settings).not.toHaveProperty("accessToken");
		expect(open(qqView).draft.settings).toMatchObject({ appSecret: "" });
	});

	it("没配的凭据格不算已存着", () => {
		const view = {
			...onebotView,
			settings: { ...cfgOf(onebotView), accessToken: undefined },
		} as unknown as ConnectionView;
		expect(open(view).saved).toEqual({});
	});

	it("webhook 的地址与 secret、官机 appSecret、OneBot token 各是凭据格;拓展连接没有", () => {
		expect(credentialCellsOf(open(webhookView).base).map((c) => c.key)).toEqual(["url", "secret"]);
		expect(credentialCellsOf(open(qqView).base).map((c) => c.key)).toEqual(["appSecret"]);
		expect(credentialCellsOf(open(onebotView).base).map((c) => c.key)).toEqual(["accessToken"]);
		const ext = { ...base, adapterKey: "bridge", platform: "qq", settings: {} };
		expect(credentialCellsOf(ext as never)).toEqual([]);
	});
});

describe("connectionPatch — 发出去的请求体", () => {
	it("只改别的格:凭据格一个都不在(带遮挡是 400)", () => {
		const { base: b, draft, saved } = open(onebotView);
		const edited = { ...draft, name: "改名" };
		const patch = connectionPatch(edited, b, saved, {});
		expect(patch).toMatchObject({ name: "改名" });
		expect(patch.settings).not.toHaveProperty("accessToken");
		expect(JSON.stringify(patch)).not.toContain("••");
	});

	it("webhook 只改名:地址与 secret 都不在", () => {
		const { base: b, draft, saved } = open(webhookView);
		const patch = connectionPatch({ ...draft, name: "x" }, b, saved, {});
		expect(patch.settings).not.toHaveProperty("url");
		expect(patch.settings).not.toHaveProperty("secret");
	});

	it("点了「换一份」并填了新值 → 发新明文", () => {
		const { base: b, draft, saved } = open(qqView);
		const edited = {
			...draft,
			settings: { ...(draft.settings as object), appSecret: "brand-new" },
		} as typeof draft;
		const patch = connectionPatch(edited, b, saved, { "settings.appSecret": true });
		expect(patch.settings).toMatchObject({ appSecret: "brand-new" });
	});

	it("点了「换一份」后留空:必填的交空串,可选的交 null", () => {
		const qq = open(qqView);
		expect(
			connectionPatch(qq.draft, qq.base, qq.saved, { "settings.appSecret": true }).settings,
		).toMatchObject({ appSecret: "" });
		const ob = open(onebotView);
		const patch = connectionPatch(ob.draft, ob.base, ob.saved, { "settings.accessToken": true });
		expect(patch.settings).toHaveProperty("accessToken", null);
		const hook = open(webhookView);
		const hp = connectionPatch(hook.draft, hook.base, hook.saved, { "settings.secret": true });
		expect(hp.settings).toHaveProperty("secret", null);
		expect(hp.settings).not.toHaveProperty("url");
	});

	it("本来没配的凭据格:填了就发,没填就不提", () => {
		const view = {
			...onebotView,
			settings: { ...cfgOf(onebotView), accessToken: undefined },
		} as unknown as ConnectionView;
		const { base: b, draft, saved } = open(view);
		const none = connectionPatch(draft, b, saved, {});
		expect(none.settings).not.toHaveProperty("accessToken");
		const typed = {
			...draft,
			settings: { ...(draft.settings as object), accessToken: "tok" },
		} as typeof draft;
		expect(connectionPatch(typed, b, saved, {}).settings).toMatchObject({ accessToken: "tok" });
	});

	it("切 OneBot 连法:上一档的残字段交 null,新连法的格一起发,凭据不动", () => {
		const { base: b, draft, saved } = open(onebotView);
		const cfg = switchOnebotTransport(draft.settings as never, "ws");
		const edited = { ...draft, settings: cfg } as typeof draft;
		const patch = connectionPatch(edited, b, saved, {});
		expect(patch.settings).toMatchObject({
			transport: "ws",
			url: "ws://127.0.0.1:3001",
			baseUrl: null,
		});
		expect(patch.settings).not.toHaveProperty("accessToken");
		// 合并进存着的那条之后能过 OneBot 设置的 strict(服务端 deepMerge 的语义)。
		const stored = { ...cfgOf(onebotView), accessToken: "real-token" };
		const nextSettings: Record<string, unknown> = { ...stored };
		for (const [k, v] of Object.entries(patch.settings as Record<string, unknown>)) {
			if (v === null) delete nextSettings[k];
			else nextSettings[k] = v;
		}
		expect(OnebotConnectionSettingsSchema.safeParse(nextSettings).success).toBe(true);
	});
});
