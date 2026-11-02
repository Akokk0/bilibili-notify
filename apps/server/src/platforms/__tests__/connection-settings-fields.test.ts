import { settingsFieldsFromSchema } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { OnebotConnectionSettingsSchema } from "../onebot-settings.js";
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
