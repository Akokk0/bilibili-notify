/**
 * 设置里标了机密的格按值进日志打码的登记册(ADR-0025 决策 9 下 10-16)。
 *
 * 「哪格是机密」取面板打码那一档(`secret` 标记与清单声明),不取备份那一档:`backupOnly`
 * 的格(OneBot 地址、AI baseUrl)在日志里照显。假值一律 `FAKE-…`,长度 ≥ 8。
 */

import {
	type Connection,
	makeDefaultGlobalConfig,
	markBackupOnly,
	markSecret,
	neutralPlatformSnapshot,
	type SettingsField,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { createValueRedactor } from "../../logs/value-redactor.js";
import { createSecretCellsReader } from "../../push/connection-settings.js";
import {
	connectionView,
	globalConfigView,
	integrationSettingsView,
} from "../../routes/secret-view.js";
import { bindSettingsRedaction, secretSettingValues } from "../settings-redaction.js";

const views = {
	globals: globalConfigView,
	connection: connectionView,
	integrationSettings: integrationSettingsView,
};

const ADAPTER_SCHEMA = z.object({
	accessToken: markSecret(z.string()).default(""),
	url: markBackupOnly(z.string()).default(""),
	name: z.string().default(""),
});

function connection(
	adapterKey: string,
	settings: unknown,
	id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
): Connection {
	return {
		id,
		name: "x",
		enabled: true,
		adapterKey,
		platform: "qq",
		settings,
		platformSnapshot: neutralPlatformSnapshot("qq"),
	};
}

const SECRET_FIELD: SettingsField = {
	key: "token",
	type: "string",
	label: "令牌",
	secret: true,
} as SettingsField;
const PLAIN_FIELD: SettingsField = {
	key: "botId",
	type: "string",
	label: "机器人",
} as SettingsField;
const LIST_FIELD = {
	key: "peers",
	type: "list",
	label: "对端",
	fields: [SECRET_FIELD, PLAIN_FIELD],
} as unknown as SettingsField;

function baseInput() {
	return {
		views,
		globals: makeDefaultGlobalConfig(),
		connections: [] as Connection[],
		connectionSecrets: createSecretCellsReader({
			list: () => [{ adapterKey: "onebot", settingsSchema: ADAPTER_SCHEMA }],
		}),
		integrationSettings: [] as Array<{ key: string; schema: z.ZodType; settings: unknown }>,
		extensionSettings: {} as Record<string, unknown>,
		settingsFieldsOf: (_id: string): readonly SettingsField[] | undefined => undefined,
	};
}

describe("secretSettingValues", () => {
	it("核心设置:AI 两把 apiKey 与搜索的 key 收进来;baseUrl 与默认空串不收", () => {
		const globals = makeDefaultGlobalConfig();
		globals.ai.providers = {
			deepseek: {
				provider: "deepseek",
				label: "",
				apiKey: "FAKE-main-key",
				baseUrl: "https://FAKE-base.example/v1",
				model: "m",
				apiFlavor: "chat",
				enableThinking: false,
				thinkingLevel: "medium",
				extraParams: "",
				enableVision: false,
				vision: { baseUrl: "", apiKey: "FAKE-vision-key", model: "" },
			},
		};
		const got = secretSettingValues({ ...baseInput(), globals });
		expect(got).toContain("FAKE-main-key");
		expect(got).toContain("FAKE-vision-key");
		expect(got).not.toContain("https://FAKE-base.example/v1");
		expect(got).not.toContain("");
	});

	it("连接:标了 secret 的收进来;backupOnly 的地址与普通格不收", () => {
		const input = baseInput();
		input.connections = [
			connection("onebot", {
				accessToken: "FAKE-access-token",
				url: "ws://FAKE-host:3001",
				name: "FAKE-visible",
			}),
		];
		const got = secretSettingValues(input);
		expect(got).toEqual(["FAKE-access-token"]);
	});

	it("连接的适配器不在场 / 设置解不过:settings 里的字符串全收", () => {
		const input = baseInput();
		input.connections = [
			connection("gone.ext", { token: "FAKE-ext-token", nested: { a: "FAKE-nested-val" } }),
			connection(
				"onebot",
				{ accessToken: 12345, url: "ws://FAKE-bad-host" },
				"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			),
		];
		const got = secretSettingValues(input);
		expect(got).toEqual(
			expect.arrayContaining(["FAKE-ext-token", "FAKE-nested-val", "ws://FAKE-bad-host"]),
		);
	});

	it("拓展设置:清单标了 secret 的格(顶层与列表项)收进来,别的格不收", () => {
		const input = baseInput();
		input.extensionSettings = {
			"acme.bridge": {
				token: "FAKE-bridge-token",
				botId: "FAKE-bot-visible",
				peers: [{ token: "FAKE-peer-token", botId: "FAKE-peer-visible" }],
			},
		};
		input.settingsFieldsOf = () => [SECRET_FIELD, PLAIN_FIELD, LIST_FIELD];
		const got = secretSettingValues(input);
		expect(got.sort()).toEqual(["FAKE-bridge-token", "FAKE-peer-token"]);
	});

	it("拓展没清单(装载器还没好、清单读不了):它那份设置里的字符串全收", () => {
		const input = baseInput();
		input.extensionSettings = {
			"acme.bridge": { token: "FAKE-bridge-token", botId: "FAKE-bot-id-x", n: 7 },
		};
		const got = secretSettingValues(input);
		expect(got.sort()).toEqual(["FAKE-bot-id-x", "FAKE-bridge-token"]);
	});

	it("内置集成设置:登记段 schema 上标了 markSecret 的格收进来;没标的段收 0 个", () => {
		const input = baseInput();
		const schema = z.object({
			apiToken: markSecret(z.string()).default(""),
			nick: z.string().default(""),
		});
		input.integrationSettings = [
			{ key: "demo", schema, settings: { apiToken: "FAKE-demo-token", nick: "FAKE-nick-visible" } },
			{
				key: "plain",
				schema: z.object({ nick: z.string() }),
				settings: { nick: "FAKE-nick-plain" },
			},
		];
		expect(secretSettingValues(input)).toEqual(["FAKE-demo-token"]);
	});
});

describe("bindSettingsRedaction", () => {
	function setup() {
		const redactor = createValueRedactor();
		const replace = vi.spyOn(redactor, "replace");
		let globals = makeDefaultGlobalConfig();
		let connections: Connection[] = [];
		let extensionSettings: Record<string, unknown> = {};
		let fields: readonly SettingsField[] | undefined = [SECRET_FIELD, PLAIN_FIELD];
		const handlers: Array<(scope: string) => void> = [];
		const adapterHandlers: Array<() => void> = [];
		let adapterList: Array<{ adapterKey: string; settingsSchema: z.ZodType }> = [
			{ adapterKey: "onebot", settingsSchema: ADAPTER_SCHEMA },
		];
		const bound = bindSettingsRedaction({
			redactor,
			views,
			configStore: {
				getGlobals: () => globals,
				getConnections: () => connections,
				readIntegrationSettings: () => ({ ok: true, settings: {} }) as never,
				getAllExtensionSettings: () => extensionSettings,
				onChange: (fn) => {
					handlers.push(fn as (scope: string) => void);
					return { dispose: () => handlers.splice(handlers.indexOf(fn as never), 1) };
				},
			},
			integrationSettings: [],
			connectionSecrets: createSecretCellsReader({ list: () => adapterList }),
			adapters: {
				onChange: (fn) => {
					adapterHandlers.push(fn);
					return { dispose: () => adapterHandlers.splice(adapterHandlers.indexOf(fn), 1) };
				},
			},
			settingsFieldsOf: () => fields,
		});
		return {
			redactor,
			replace,
			bound,
			fire: (scope: string) => for_(handlers, scope),
			fireAdapters: () => {
				for (const fn of [...adapterHandlers]) fn();
			},
			setGlobals: (g: typeof globals) => (globals = g),
			setConnections: (c: Connection[]) => (connections = c),
			setExtensionSettings: (s: Record<string, unknown>) => (extensionSettings = s),
			setAdapters: (a: typeof adapterList) => (adapterList = a),
			setFields: (f: typeof fields) => (fields = f),
			handlers,
			adapterHandlers,
		};
	}
	function for_(handlers: Array<(scope: string) => void>, scope: string) {
		for (const fn of [...handlers]) fn(scope);
	}

	it("开机推一次;globals 改了 key 之后旧 key 不再遮、新 key 遮", () => {
		const ctx = setup();
		const g = makeDefaultGlobalConfig();
		g.ai.providers = {
			deepseek: {
				provider: "deepseek",
				label: "",
				apiKey: "FAKE-old-key-1",
				baseUrl: "",
				model: "",
				apiFlavor: "chat",
				enableThinking: false,
				thinkingLevel: "medium",
				extraParams: "",
				enableVision: false,
				vision: { baseUrl: "", apiKey: "", model: "" },
			},
		};
		ctx.setGlobals(g);
		ctx.bound.sync();
		expect(ctx.redactor.scrub("k=FAKE-old-key-1")).toBe("k=***");
		const next = structuredClone(g);
		const bucket = next.ai.providers.deepseek;
		if (!bucket) throw new Error("fixture");
		bucket.apiKey = "FAKE-new-key-2";
		ctx.setGlobals(next);
		ctx.fire("globals");
		expect(ctx.redactor.scrub("k=FAKE-old-key-1 FAKE-new-key-2")).toBe("k=FAKE-old-key-1 ***");
	});

	it("连接删掉之后它的 secret 不再遮;拓展设置写入后新 token 遮", () => {
		const ctx = setup();
		ctx.setConnections([connection("onebot", { accessToken: "FAKE-access-token" })]);
		ctx.fire("connections");
		expect(ctx.redactor.scrub("FAKE-access-token")).toBe("***");
		ctx.setConnections([]);
		ctx.fire("connections");
		expect(ctx.redactor.scrub("FAKE-access-token")).toBe("FAKE-access-token");
		ctx.setExtensionSettings({
			"acme.bridge": { token: "FAKE-bridge-token", botId: "FAKE-bot-visible" },
		});
		ctx.fire("integration-settings");
		expect(ctx.redactor.scrub("FAKE-bridge-token FAKE-bot-visible")).toBe("*** FAKE-bot-visible");
	});

	it("适配器撤下后它连接的 settings 整格登记;再登记回来又只剩标记的格", () => {
		const ctx = setup();
		ctx.setConnections([
			connection("onebot", { accessToken: "FAKE-access-token", url: "ws://FAKE-host:3001" }),
		]);
		ctx.fire("connections");
		expect(ctx.redactor.scrub("ws://FAKE-host:3001")).toBe("ws://FAKE-host:3001");
		const present = [{ adapterKey: "onebot", settingsSchema: ADAPTER_SCHEMA }];
		ctx.setAdapters([]);
		ctx.fireAdapters();
		expect(ctx.redactor.scrub("ws://FAKE-host:3001")).toBe("***");
		ctx.setAdapters(present);
		ctx.fireAdapters();
		expect(ctx.redactor.scrub("ws://FAKE-host:3001")).toBe("ws://FAKE-host:3001");
	});

	it("算出来的一批与上一次一样就不调 replace;dispose 之后不再换、已登记的不撤", () => {
		const ctx = setup();
		ctx.setConnections([connection("onebot", { accessToken: "FAKE-access-token" })]);
		ctx.fire("connections");
		const calls = ctx.replace.mock.calls.length;
		ctx.fire("connections");
		ctx.fire("globals");
		expect(ctx.replace.mock.calls.length).toBe(calls);
		ctx.bound.dispose();
		expect(ctx.handlers).toHaveLength(0);
		expect(ctx.adapterHandlers).toHaveLength(0);
		expect(ctx.redactor.scrub("FAKE-access-token")).toBe("***");
	});

	it("别的 scope(订阅、目标)不触发重算", () => {
		const ctx = setup();
		const calls = ctx.replace.mock.calls.length;
		ctx.setConnections([connection("onebot", { accessToken: "FAKE-access-token" })]);
		ctx.fire("subscriptions");
		ctx.fire("targets");
		expect(ctx.replace.mock.calls.length).toBe(calls);
	});
});
