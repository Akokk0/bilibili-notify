import { markBackupOnly, markSecret } from "@bilibili-notify/internal";
import { z } from "zod";
import { t as tr } from "../i18n/index.js";
import { ONEBOT_FORWARD_MIN_TIMEOUT_MS, ONEBOT_IMAGE_MIN_TIMEOUT_MS } from "./onebot-constants.js";
import { fieldText } from "./settings-field-text.js";

/**
 * OneBot 连接的三种连法(`transport`)共用的字段。
 * `transport` 是连接属性,只活在连接的 settings 里 —— PushTarget 不受影响。
 */
const onebotCommonSettingsShape = {
	accessToken: markSecret(
		z.string().meta(
			fieldText(
				() => ({
					label: tr("platforms.connection.token.label"),
					description: tr("platforms.connection.token.description"),
				}),
				{
					secret: true,
				},
			),
		),
	).optional(),
	/** OneBot 协议版本；首期固定 v11，留位以便后续扩展 v12。 */
	protocolVersion: z.literal("v11").default("v11"),
	/** 单次操作总超时（毫秒）。HTTP = 请求超时；WS = 等 echo 响应超时。 */
	timeoutMs: z
		.number()
		.int()
		.min(1)
		.default(15_000)
		.meta(
			fieldText(
				() => ({
					label: tr("platforms.connection.timeout.label"),
					description: tr("platforms.connection.timeout.description"),
				}),
				{
					step: 1000,
					unit: "ms",
				},
			),
		),
	/**
	 * 带图普通消息的超时**下限**（毫秒）。协议端要先把图传到 QQ 图床才回响应，实测
	 * 常超 15s，所以取 `max(timeoutMs, 此值)` 单独放宽。`0` = 关闭放宽，严格按
	 * `timeoutMs` 走（想让挂掉的 bot 快速失败、别拖住串行发送的后续目标时用）。
	 */
	imageMinTimeoutMs: z
		.number()
		.int()
		.min(0)
		.default(ONEBOT_IMAGE_MIN_TIMEOUT_MS)
		.meta(
			fieldText(
				() => ({
					label: tr("platforms.connection.imageMinTimeoutMs.label"),
					description: tr("platforms.connection.imageMinTimeoutMs.description"),
				}),
				{ step: 1000, unit: "ms" },
			),
		),
	/** 合并转发（`send_*_forward_msg`）的超时下限（毫秒）。语义同上，`0` = 关闭放宽。 */
	mergeForwardMinTimeoutMs: z
		.number()
		.int()
		.min(0)
		.default(ONEBOT_FORWARD_MIN_TIMEOUT_MS)
		.meta(
			fieldText(
				() => ({
					label: tr("platforms.connection.mergeForwardMinTimeoutMs.label"),
					description: tr("platforms.connection.mergeForwardMinTimeoutMs.description"),
				}),
				{ step: 1000, unit: "ms" },
			),
		),
	/** 失败时的重试次数（不含首次）。 */
	maxRetries: z
		.number()
		.int()
		.min(0)
		.default(0)
		.meta(
			fieldText(
				() => ({
					label: tr("platforms.connection.maxRetries.label"),
					description: tr("platforms.connection.maxRetries.description"),
				}),
				{
					preserveTruthy: true,
					get unit() {
						return tr("platforms.connection.maxRetries.unit");
					},
				},
			),
		),
	/** 两次重试之间的等待（毫秒）。 */
	retryIntervalMs: z
		.number()
		.int()
		.min(0)
		.default(1_000)
		.meta(
			fieldText(() => ({ label: tr("platforms.connection.retryIntervalMs.label") }), {
				step: 500,
				unit: "ms",
			}),
		),
} as const;

/** HTTP:独立端用 fetch POST 到 bot 的 OneBot HTTP API。 */
export const OnebotHttpSettingsSchema = z
	.object({
		transport: z.literal("http"),
		/** bot 的 OneBot HTTP API 根地址。 */
		baseUrl: markBackupOnly(
			z.url().meta(
				fieldText(() => ({ label: tr("platforms.connection.baseUrl.label") }), {
					monospace: true,
					placeholder: "http://napcat:3000",
				}),
			),
			{ url: true },
		),
		...onebotCommonSettingsShape,
		/** 附加到每次请求的 HTTP header（例如自定义鉴权头）。 */
		headers: z
			.record(z.string(), markBackupOnly(z.string()))
			.default({})
			.meta(
				fieldText(() => ({
					label: tr("platforms.connection.headers.label"),
					description: tr("platforms.connection.headers.description"),
				})),
			),
	})
	.strict()
	.meta({ initial: { baseUrl: "http://127.0.0.1:3000" } });

/** 正向 WS:独立端作为 WS 客户端,主动连到 bot 的 WS 服务。 */
export const OnebotWsSettingsSchema = z
	.object({
		transport: z.literal("ws"),
		/** bot 的 OneBot 正向 WS 地址,必须 `ws://` 或 `wss://`。 */
		url: markBackupOnly(
			z
				.string()
				.regex(/^wss?:\/\/\S+$/i, { error: () => tr("platforms.connection.wsUrl.invalid") })
				.meta(
					fieldText(
						() => ({
							label: tr("platforms.connection.wsUrl.label"),
							description: tr("platforms.connection.wsUrl.description"),
						}),
						{
							monospace: true,
							placeholder: "ws://napcat:3001",
						},
					),
				),
			{
				url: true,
			},
		),
		...onebotCommonSettingsShape,
		/** WS 握手请求头（例如自定义鉴权头）。 */
		headers: z
			.record(z.string(), markBackupOnly(z.string()))
			.default({})
			.meta(
				fieldText(() => ({
					label: tr("platforms.connection.headers.label"),
					description: tr("platforms.connection.headers.description"),
				})),
			),
	})
	.strict()
	.meta({ initial: { url: "ws://127.0.0.1:3001", maxRetries: 3 } });

/** 反向 WS:独立端监听 `port`,bot 作为客户端主动连进来。端口即身份。 */
export const OnebotWsReverseSettingsSchema = z
	.object({
		transport: z.literal("ws-reverse"),
		/** 独立端为该连接开的 WS 监听端口；bot 连 `ws://<host>:<port>/`。 */
		port: z
			.number()
			.int()
			.min(1)
			.max(65_535)
			.meta(
				fieldText(
					() => ({
						label: tr("platforms.connection.port.label"),
						description: tr("platforms.connection.port.description"),
					}),
					{
						listener: { scheme: "ws" },
					},
				),
			),
		...onebotCommonSettingsShape,
	})
	.strict()
	.meta({ initial: { port: 9797, maxRetries: 3 } });

/** OneBot 连接设置 —— 按 `transport` 区分 HTTP / 正向 WS / 反向 WS。 */
export const OnebotConnectionSettingsSchema = z
	.discriminatedUnion("transport", [
		OnebotHttpSettingsSchema,
		OnebotWsSettingsSchema,
		OnebotWsReverseSettingsSchema,
	])
	.meta(
		fieldText(() => ({ label: tr("platforms.connection.transport.label") }), {
			get options() {
				return {
					http: { label: "HTTP" },
					ws: { label: tr("platforms.connection.transport.ws") },
					"ws-reverse": { label: tr("platforms.connection.transport.reverse") },
				};
			},
		}),
	);
export type OnebotConnectionSettings = z.infer<typeof OnebotConnectionSettingsSchema>;
export type OnebotTransport = OnebotConnectionSettings["transport"];
