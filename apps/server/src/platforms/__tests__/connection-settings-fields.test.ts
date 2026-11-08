import { settingsFieldsFromSchema } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { OnebotConnectionSettingsSchema, OnebotWsSettingsSchema } from "../onebot-settings.js";
import { WebhookConnectionSettingsSchema } from "../webhook-settings.js";

describe("内置连接表单", () => {
	it("已建好的内置规则在读取描述时才翻译,字段、枚举与平台提示均随语言变化", () => {
		const binding = vi.spyOn(i18n.state(), "t").mockImplementation((key) => `译:${key}`);
		try {
			const fields = settingsFieldsFromSchema(OnebotConnectionSettingsSchema, { connection: true });
			expect(fields[0]?.label).toBe("译:platforms.connection.transport.label");
			expect(fields.find((field) => field.key === "accessToken")?.label).toBe(
				"译:platforms.connection.token.label",
			);
			const hook = settingsFieldsFromSchema(WebhookConnectionSettingsSchema, { connection: true });
			expect(hook.find((field) => field.key === "secret")?.byPlatform?.feishu?.description).toBe(
				"译:platforms.connection.hookSecret.feishu",
			);
		} finally {
			binding.mockRestore();
		}
	});
});

it("localizes built-in connection metadata and validation without changing protocol values", () => {
	const previous = i18n.state();
	const schema = OnebotConnectionSettingsSchema;
	const keys = settingsFieldsFromSchema(schema, { connection: true }).map((field) => field.key);
	try {
		for (const [locale, transport, timeout, ws, invalidUrl] of [
			[
				"en",
				"Transport",
				"Response timeout",
				"Forward WS",
				"The address must start with ws:// or wss://.",
			],
			[
				"ja",
				"接続方式",
				"応答タイムアウト",
				"順方向WS",
				"ws://またはwss://で始まるアドレスを指定してください。",
			],
			["zh-TW", "連線方式", "回應逾時", "正向 WS", "必須是 ws:// 或 wss:// 網址。"],
		] as const) {
			i18n.set({ locale, voice: "plain" });
			const fields = settingsFieldsFromSchema(schema, { connection: true });
			expect(fields.map((field) => field.key)).toEqual(keys);
			expect(fields[0]).toMatchObject({ key: "transport", label: transport });
			expect(fields.find((field) => field.key === "timeoutMs")?.label).toBe(timeout);
			const transportField = fields[0];
			if (transportField?.type !== "enum") throw new Error("Expected transport choices");
			expect(transportField.options.find((option) => option.value === "ws")?.label).toBe(ws);
			expect(
				OnebotWsSettingsSchema.safeParse({ transport: "ws", url: "https://example.com" }).error
					?.issues[0],
			).toMatchObject({ code: "invalid_format", path: ["url"], message: invalidUrl });
		}
	} finally {
		i18n.set({ locale: previous.locale, voice: previous.voice });
	}
});
