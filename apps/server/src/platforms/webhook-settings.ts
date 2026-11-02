import { markBackupOnly, markSecret } from "@bilibili-notify/internal";
import { z } from "zod";
import { t as tr } from "../i18n/index.js";
import { WEBHOOK_PLATFORMS } from "./platform-descriptors.js";
import { fieldText } from "./settings-field-text.js";

/** webhook 支持的模板平台。 */
export const WebhookPlatformSchema = z.enum(WEBHOOK_PLATFORMS);

/**
 * 出站 webhook 的连接设置。
 *
 * **这里没有 `provider`** —— 它升格成了 `platform`(见 {@link WEBHOOK_PLATFORMS})。
 * 老配置里那个字段由 `schema/migration.ts` 提上去并从 settings 里摘掉;这一层是非 strict
 * 的 z.object,所以万一漏了一条,strip 掉也不会让主人开不了机。
 */
export const WebhookConnectionSettingsSchema = z.object({
	url: markSecret(
		z.url().meta(
			fieldText(() => ({ label: tr("platforms.connection.hookUrl.label") }), {
				monospace: true,
				secret: true,
				byPlatform: {
					dingtalk: { placeholder: "https://oapi.dingtalk.com/robot/send?access_token=..." },
					feishu: { placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/..." },
					wecom: { placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." },
					generic: { placeholder: "https://hooks.example.com/bn" },
				},
			}),
		),
		{ url: true },
	),
	secret: markSecret(
		z.string().meta(
			fieldText(
				() => ({
					label: tr("platforms.connection.hookSecret.label"),
					description: tr("platforms.connection.hookSecret.description"),
				}),
				{
					secret: true,
					get byPlatform() {
						return {
							dingtalk: { description: tr("platforms.connection.hookSecret.dingtalk") },
							feishu: { description: tr("platforms.connection.hookSecret.feishu") },
							wecom: { description: tr("platforms.connection.hookSecret.wecom") },
							generic: { description: tr("platforms.connection.hookSecret.generic") },
						};
					},
				},
			),
		),
	).optional(),
	/** 自定义 header 例如 Authorization */
	headers: z
		.record(z.string(), markBackupOnly(z.string()))
		.default({})
		.meta(
			fieldText(() => ({
				label: tr("platforms.connection.headers.label"),
				description: tr("platforms.connection.headers.description"),
			})),
		),
});
export type WebhookConnectionSettings = z.infer<typeof WebhookConnectionSettingsSchema>;
