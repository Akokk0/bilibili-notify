import { mapMarked } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import type { z } from "zod";
import { OnebotConnectionSettingsSchema } from "../onebot-settings.js";
import { QQOfficialConnectionSettingsSchema } from "../qq-official-settings.js";
import { WebhookConnectionSettingsSchema } from "../webhook-settings.js";

describe("真 schema 上的标记", () => {
	const marked = (schema: z.ZodType, value: unknown) => {
		const out: Array<{ mark: string; value: unknown }> = [];
		mapMarked(schema, value, {
			onMark: (value, mark) => {
				out.push({ mark: "secret" in mark ? "secret" : "backupOnly", value });
				return value;
			},
			onUntyped: (v) => v,
		});
		return out;
	};

	it("OneBot ws 的 url 只算「仅备份」,webhook 的 url 算 secret(同名不同义的反例)", () => {
		const ws = OnebotConnectionSettingsSchema.parse({
			transport: "ws",
			url: "ws://bot:3001",
			accessToken: "tok",
			headers: { A: "1" },
		});
		const wsMarks = marked(OnebotConnectionSettingsSchema, ws);
		expect(wsMarks).toHaveLength(3);
		expect(wsMarks).toEqual(
			expect.arrayContaining([
				{ mark: "backupOnly", value: "ws://bot:3001" },
				{ mark: "backupOnly", value: "1" },
				{ mark: "secret", value: "tok" },
			]),
		);
		const hook = WebhookConnectionSettingsSchema.parse({
			url: "https://h.example/x",
			secret: "s",
			headers: {},
		});
		expect(marked(WebhookConnectionSettingsSchema, hook)).toEqual([
			{ mark: "secret", value: "https://h.example/x" },
			{ mark: "secret", value: "s" },
		]);
	});

	it("QQ 官机的 appSecret 是 secret", () => {
		const qq = QQOfficialConnectionSettingsSchema.parse({ appId: "1", appSecret: "sec" });
		expect(marked(QQOfficialConnectionSettingsSchema, qq)).toEqual([
			{ mark: "secret", value: "sec" },
		]);
	});
});
