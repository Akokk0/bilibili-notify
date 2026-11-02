import { markSecret } from "@bilibili-notify/internal";
import { z } from "zod";
import { t as tr } from "../i18n/index.js";
import { fieldText } from "./settings-field-text.js";

/**
 * QQ 官方机器人公域/私域类型。私域可发原生 markdown,公域只能发模板 markdown ——
 * 决定 adapter 的 markdown 能力门控(私域默认开、公域默认关)。
 */
export const QQOfficialBotTypeSchema = z.enum(["public", "private"]);
export type QQOfficialBotType = z.infer<typeof QQOfficialBotTypeSchema>;

/**
 * QQ 官方机器人(q.qq.com,非 OneBot/NapCat)连接设置。
 * 鉴权 appId+appSecret → getAppAccessToken;`sandbox` 切沙箱/正式环境的 wss+REST host。
 */
export const QQOfficialConnectionSettingsSchema = z
	.object({
		appId: z
			.string()
			.min(1)
			.meta(
				fieldText(
					() => ({
						label: tr("platforms.connection.appId.label"),
						description: tr("platforms.connection.appId.description"),
					}),
					{
						monospace: true,
						placeholder: "102xxxxxx",
					},
				),
			),
		/**
		 * 空串 = 尚未配置密钥,**合法可存**(与 onebot 的 `accessToken`、webhook 的
		 * `secret` 建模一致)。这里曾经是 `.min(1)`,结果脱敏备份把 appSecret 抹成空串
		 * 后就再也存不回去 —— 恢复直接 ConfigValidationError(scope=connections)。
		 *
		 * 「要有真密钥才能连」是**连接期**的约束,不是**存储期**的:见
		 * `platforms/qq-official.ts` 的 isAvailable / reconcile,两处都拒绝空密钥的
		 * adapter,不会拿空密钥去撞 QQ 网关。
		 */
		appSecret: markSecret(
			z.string().meta(
				fieldText(
					() => ({
						label: tr("platforms.connection.appSecret.label"),
						description: tr("platforms.connection.appSecret.description"),
					}),
					{ secret: true },
				),
			),
		),
		sandbox: z
			.boolean()
			.default(false)
			.meta(
				fieldText(() => ({
					label: tr("platforms.connection.sandbox.label"),
					description: tr("platforms.connection.sandbox.description"),
				})),
			),
		botType: QQOfficialBotTypeSchema.default("public").meta(
			fieldText(
				() => ({
					label: tr("platforms.connection.botType.label"),
					description: tr("platforms.connection.botType.description"),
				}),
				{
					get options() {
						return {
							public: { label: tr("platforms.connection.botType.public") },
							private: { label: tr("platforms.connection.botType.private") },
						};
					},
				},
			),
		),
		/** 是否记录网关 RECONNECT/RESUMED 事件日志。QQ 官方网关每约 30 分钟主动要求
		 * 重连一次,属正常协议行为;默认关闭避免刷屏,排障时可开启。 */
		logReconnects: z
			.boolean()
			.default(false)
			.meta(
				fieldText(() => ({
					label: tr("platforms.connection.logReconnects.label"),
					description: tr("platforms.connection.logReconnects.description"),
				})),
			),
	})
	.strict();
export type QQOfficialConnectionSettings = z.infer<typeof QQOfficialConnectionSettingsSchema>;
