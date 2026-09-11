/**
 * 连接配置表单的**字段表** —— 一条连接摆哪几栏、每栏叫什么、填进去写到 config 的哪一格。
 *
 * 这些原先是 `Targets.tsx` 里按平台分的三段手写 JSX,加起来近三百行。三段之间没有共同
 * 形状,于是「加一个平台」= 在一个近两千行的页面里再插一段;而每栏的标签、提示、上下限、
 * 挂到哪个 config 键,全都只存在于那段 JSX 里 —— 想知道 OneBot 到底有几栏,只能读代码。
 *
 * 收成一张表之后:页面那一侧只剩「按 kind 画控件」,一行平台判断都没有;要加平台就在这里
 * 加一段 —— 而且它是**数据**,`connection-fields.test.ts` 能直接拿它跟 zod schema 对表
 * (有哪些键、默认值多少),这在 JSX 里做不到。
 *
 * 每一栏自带 `set`:吃新值、交回**整条新连接**。这样键怎么挂是表自己的事(OneBot 换连法
 * 要整份换 config 并同步 `connector`,官机扫码回填还要补显示名),页面不用知道。
 */

import type { ExtensionConfigField } from "@bilibili-notify/contract";
import type {
	Connection,
	DirectConnection,
	ExtensionConnection,
	OnebotConnectionConfig,
	OnebotTransport,
	QQOfficialBotType,
	QQOfficialConnectionConfig,
} from "@bilibili-notify/internal";
import {
	ONEBOT_FORWARD_MIN_TIMEOUT_MS,
	ONEBOT_IMAGE_MIN_TIMEOUT_MS,
} from "@bilibili-notify/internal/constants";
import { switchOnebotTransport, webhookSecretHint, webhookUrlPlaceholder } from "./domain";

interface FieldBase {
	/** 全局唯一的字段身份 —— 默认值广播、导览聚光灯、测试都按它找。 */
	code: string;
	label: string;
	hint?: string;
	required?: boolean;
}

export type ConnectionField =
	| (FieldBase & {
			kind: "text";
			value: string;
			placeholder?: string;
			mono?: boolean;
			secret?: boolean;
			set: (v: string) => Connection;
	  })
	| (FieldBase & {
			kind: "number";
			value: number;
			min?: number;
			max?: number;
			step?: number;
			suffix?: string;
			width?: number;
			set: (v: number) => Connection;
	  })
	| (FieldBase & { kind: "toggle"; value: boolean; set: (v: boolean) => Connection })
	| (FieldBase & {
			kind: "select";
			value: string;
			options: ReadonlyArray<{ value: string; label: string }>;
			set: (v: string) => Connection;
	  })
	/** 「一排里选一个」的胶囊。与 select 的差别只在长相 —— 连法那一排要用平台标识色。 */
	| (FieldBase & {
			kind: "chips";
			value: string;
			options: ReadonlyArray<{ value: string; label: string }>;
			set: (v: string) => Connection;
	  })
	| (FieldBase & {
			kind: "headers";
			value: Record<string, string>;
			set: (v: Record<string, string>) => Connection;
	  })
	/** 官机的扫码建号行 —— 不是一栏字段,是一整行说明加一颗按钮。 */
	| {
			kind: "qq-bind";
			/** 扫出来的凭据 → 整条新连接(顺手归好域 / 沙箱、补上空着的显示名)。 */
			apply: (creds: { appId: string; appSecret: string }) => Connection;
	  };

/** OneBot 的三种连法。 */
const ONEBOT_TRANSPORTS: ReadonlyArray<{ value: OnebotTransport; label: string }> = [
	{ value: "http", label: "HTTP" },
	{ value: "ws", label: "正向 WS" },
	{ value: "ws-reverse", label: "反向 WS" },
];

function onebotFields(
	connection: Extract<DirectConnection, { platform: "onebot" }>,
): ConnectionField[] {
	const cfg = connection.config;
	// connector 跟着 transport 走 —— 这一版两份并存,schema 的 refine 会把漂掉的挡下来。
	const setCfg = (next: OnebotConnectionConfig): Connection => ({
		...connection,
		connector: next.transport,
		config: next,
	});
	const patch = (over: Partial<OnebotConnectionConfig>): Connection =>
		setCfg({ ...cfg, ...over } as OnebotConnectionConfig);

	const fields: ConnectionField[] = [
		{
			kind: "chips",
			code: "config.transport",
			label: "连接方式",
			required: true,
			value: cfg.transport,
			options: ONEBOT_TRANSPORTS,
			// 整份换掉 config(branch schema 是 strict,不能留上一档的残字段),共用字段留着。
			set: (v) => setCfg(switchOnebotTransport(cfg, v as OnebotTransport)),
		},
	];

	if (cfg.transport === "http") {
		fields.push({
			kind: "text",
			code: "config.baseUrl",
			label: "HTTP baseUrl",
			required: true,
			mono: true,
			placeholder: "http://napcat:3000",
			value: cfg.baseUrl,
			set: (v) => setCfg({ ...cfg, baseUrl: v }),
		});
	}
	if (cfg.transport === "ws") {
		fields.push({
			kind: "text",
			code: "config.url",
			label: "正向 WS 地址",
			required: true,
			mono: true,
			hint: "bot 的 OneBot 正向 WS 服务",
			placeholder: "ws://napcat:3001",
			value: cfg.url,
			set: (v) => setCfg({ ...cfg, url: v }),
		});
	}
	if (cfg.transport === "ws-reverse") {
		fields.push({
			kind: "number",
			code: "config.port",
			label: "反向 WS 监听端口",
			hint: "bot 主动连入此端口;端口即身份,与主端口 8787 独立",
			min: 1,
			max: 65_535,
			width: 120,
			value: cfg.port,
			set: (v) => setCfg({ ...cfg, port: v }),
		});
	}

	fields.push({
		kind: "text",
		code: "config.accessToken",
		label: "accessToken",
		secret: true,
		hint:
			cfg.transport === "ws-reverse"
				? "校验连入 bot 的握手;反向 WS 强烈建议设置,否则端口对局域网裸开"
				: undefined,
		value: cfg.accessToken ?? "",
		set: (v) => patch({ accessToken: v || undefined }),
	});

	// 这句 hint 要说的不是「超时是什么」,而是「为什么它看起来没生效」:带图消息另有更长的
	// 下限,不然主人会以为自己调的 15s 被无视了。下限现在就在下面两栏里,调得动也关得掉 ——
	// 别再让它在代码里悄悄盖掉主人配的数。
	const http = cfg.transport === "http";
	fields.push(
		{
			kind: "number",
			code: "config.timeoutMs",
			label: http ? "请求超时" : "响应超时",
			hint: `${
				http ? "单次 HTTP 请求总超时(毫秒)" : "等 OneBot echo 响应的超时"
			}。纯文字消息按这个数走；带图的另看下面两栏的下限`,
			min: 1000,
			step: 1000,
			suffix: "ms",
			width: 120,
			value: cfg.timeoutMs,
			set: (v) => patch({ timeoutMs: v }),
		},
		{
			kind: "number",
			code: "config.imageMinTimeoutMs",
			label: "带图超时下限",
			hint: `带图消息实际等 max(上面的超时, 此值)。协议端要先把图传到 QQ 图床才回响应，实测常超 15s，所以单独放宽（默认 ${ONEBOT_IMAGE_MIN_TIMEOUT_MS / 1000}s）。填 0 = 不放宽，严格按上面的超时走`,
			min: 0,
			step: 1000,
			suffix: "ms",
			width: 120,
			value: cfg.imageMinTimeoutMs,
			set: (v) => patch({ imageMinTimeoutMs: v }),
		},
		{
			kind: "number",
			code: "config.forwardMinTimeoutMs",
			label: "合并转发超时下限",
			hint: `语义同上，只是合并转发要把每张图逐张下载再上传组装，更慢（默认 ${ONEBOT_FORWARD_MIN_TIMEOUT_MS / 1000}s）。填 0 = 不放宽`,
			min: 0,
			step: 1000,
			suffix: "ms",
			width: 120,
			value: cfg.forwardMinTimeoutMs,
			set: (v) => patch({ forwardMinTimeoutMs: v }),
		},
		{
			kind: "number",
			code: "config.retryTimes",
			label: "重试次数",
			hint: "不含首次,失败后再尝试",
			min: 0,
			max: 10,
			suffix: "次",
			value: cfg.retryTimes,
			set: (v) => patch({ retryTimes: v }),
		},
		{
			kind: "number",
			code: "config.retryIntervalMs",
			label: "重试间隔",
			min: 0,
			step: 500,
			suffix: "ms",
			width: 120,
			value: cfg.retryIntervalMs,
			set: (v) => patch({ retryIntervalMs: v }),
		},
	);

	// 反向 WS 没有这一栏:请求头是我们发出去时才有的东西,bot 连进来那一头没得填。
	if (cfg.transport !== "ws-reverse") {
		fields.push({
			kind: "headers",
			code: "config.headers",
			label: http ? "自定义请求头" : "WS 握手头",
			hint: "例如反向代理鉴权头",
			value: cfg.headers,
			set: (v) => setCfg({ ...cfg, headers: v }),
		});
	}
	return fields;
}

const QQ_BOT_TYPES: ReadonlyArray<{ value: QQOfficialBotType; label: string }> = [
	{ value: "public", label: "公域" },
	{ value: "private", label: "私域" },
];

function qqOfficialFields(
	connection: Extract<DirectConnection, { platform: "qq-official" }>,
): ConnectionField[] {
	const cfg = connection.config;
	const setCfg = (next: QQOfficialConnectionConfig): Connection => ({
		...connection,
		config: next,
	});
	return [
		{
			kind: "qq-bind",
			// 回填 = 「用扫出来的这个 lite bot」,顺手把域 / 沙箱归到它的正确档:lite bot 无原生
			// markdown 特权,留在私域档会让图集推送必败。显示名称为空时补默认名 —— 扫码流程
			// 跳过了表单上半截,名称空着会让保存钮一直灰着(唯一前端必填),用户看不出为什么存不了。
			apply: ({ appId, appSecret }) => ({
				...connection,
				name: connection.name.trim() ? connection.name : `QQ 机器人 ${appId}`,
				config: { ...cfg, appId, appSecret, botType: "public", sandbox: false },
			}),
		},
		{
			kind: "text",
			code: "config.appId",
			label: "AppID",
			required: true,
			mono: true,
			hint: "QQ 开放平台机器人的 AppID(明文存储)",
			placeholder: "102xxxxxx",
			value: cfg.appId,
			set: (v) => setCfg({ ...cfg, appId: v }),
		},
		{
			kind: "text",
			code: "config.appSecret",
			label: "AppSecret",
			required: true,
			secret: true,
			hint: "机器人密钥;用于换取 App Access Token",
			value: cfg.appSecret,
			set: (v) => setCfg({ ...cfg, appSecret: v }),
		},
		{
			kind: "select",
			code: "config.botType",
			label: "机器人域",
			required: true,
			hint: "私域可发原生 markdown(图集合并成一条多图);公域不支持原生 markdown(图集逐条发,需报备模板)",
			options: QQ_BOT_TYPES,
			value: cfg.botType,
			set: (v) => setCfg({ ...cfg, botType: v as QQOfficialBotType }),
		},
		{
			kind: "toggle",
			code: "config.sandbox",
			label: "沙箱模式",
			hint: "开启后走 QQ 沙箱环境(sandbox.api.sgroup.qq.com),仅对沙箱内成员可见",
			value: cfg.sandbox,
			set: (v) => setCfg({ ...cfg, sandbox: v }),
		},
		{
			kind: "toggle",
			code: "config.logReconnects",
			label: "记录重连日志",
			hint: "QQ 官方网关约每 30 分钟主动要求重连一次,属正常协议行为;默认关闭避免刷屏,排障时可开启",
			value: cfg.logReconnects,
			set: (v) => setCfg({ ...cfg, logReconnects: v }),
		},
	];
}

function webhookFields(
	connection: Extract<DirectConnection, { connector: "webhook" }>,
): ConnectionField[] {
	const cfg = connection.config;
	// 「哪家的机器人」原先是这张表里一个叫「Webhook 协议」的下拉 —— 它现在就是上面那排
	// 平台胶囊,不再问第二遍。
	const platform = connection.platform;
	const fields: ConnectionField[] = [
		{
			kind: "text",
			code: "config.url",
			label: "URL",
			required: true,
			mono: true,
			placeholder: webhookUrlPlaceholder(platform),
			value: cfg.url,
			set: (v) => ({ ...connection, config: { ...cfg, url: v } }),
		},
		{
			kind: "text",
			code: "config.secret",
			label: "Secret",
			secret: true,
			hint: webhookSecretHint(platform),
			value: cfg.secret ?? "",
			set: (v) => ({ ...connection, config: { ...cfg, secret: v || undefined } }),
		},
	];

	// 自定义请求头**四家都给**(主人拍板要统一)。`config.headers` 本来就是四家共用的一格,
	// 投递时也确实摊进每一次 POST(`platforms/webhook.ts` 的 `baseHeaders`)——「官方 hook
	// 用不上」只在直连官方地址时成立,一旦谁把它挡在反向代理后面就不成立了,而那种情况
	// 少一栏就等于从面板配不出来。
	fields.push({
		kind: "headers",
		code: "config.headers",
		label: "自定义请求头",
		hint: "端点挡在反向代理 / Cloudflare Access 后面时要带的鉴权头(如 Authorization)。直连官方地址一般用不上;签名密钥填上面那栏,别写这里",
		value: cfg.headers,
		set: (v) => ({ ...connection, config: { ...cfg, headers: v } }),
	});
	return fields;
}

/**
 * 这条连接的配置该摆哪几栏。
 *
 * 桥接入眼下给空表 —— 它的参数(BN 地址 + token)在拓展页那侧填,不走这张连接表单。
 * 认不出的也给空表:页面那一侧不用再写一句兜底。
 */
/**
 * 拓展连接的表单:拓展交上来的字段表(`ExtensionDTO.configFields`,ADR-0012 决策 33)
 * 一栏翻一栏。字段身份带着拓展 id(`ext.<id>.<code>`),与内置平台的字段不撞。
 * 值就落在 `config[code]`,这一层不认得任何具体拓展。
 */
export function extensionConnectionFields(
	connection: ExtensionConnection,
	fields: readonly ExtensionConfigField[],
): ConnectionField[] {
	const bag = (
		typeof connection.config === "object" && connection.config !== null ? connection.config : {}
	) as Record<string, unknown>;
	const put = (code: string, v: unknown): Connection => ({
		...connection,
		config: { ...bag, [code]: v },
	});
	return fields.map((field): ConnectionField => {
		const base = {
			code: `ext.${connection.extensionId}.${field.code}`,
			label: field.label,
			hint: field.hint,
			required: field.required,
		};
		const raw = bag[field.code];
		switch (field.kind) {
			case "text":
				return {
					...base,
					kind: "text",
					value: typeof raw === "string" ? raw : "",
					placeholder: field.placeholder,
					mono: field.mono,
					secret: field.secret,
					set: (v) => put(field.code, v),
				};
			case "number":
				return {
					...base,
					kind: "number",
					value: typeof raw === "number" ? raw : (field.min ?? 0),
					min: field.min,
					max: field.max,
					step: field.step,
					suffix: field.suffix,
					set: (v) => put(field.code, v),
				};
			case "toggle":
				return { ...base, kind: "toggle", value: raw === true, set: (v) => put(field.code, v) };
			case "select":
				return {
					...base,
					kind: "select",
					value: typeof raw === "string" ? raw : (field.options[0]?.value ?? ""),
					options: field.options,
					set: (v) => put(field.code, v),
				};
			default: {
				// 字段表加了新 kind 而这里没接 —— 编译期就该红,别悄悄画成空白。
				const never: never = field;
				throw new Error(`unknown extension field kind: ${JSON.stringify(never)}`);
			}
		}
	});
}

export function connectionFields(connection: Connection): ConnectionField[] {
	if (connection.kind !== "direct") return [];
	if (connection.platform === "onebot") return onebotFields(connection);
	if (connection.platform === "qq-official") return qqOfficialFields(connection);
	if (connection.connector === "webhook") return webhookFields(connection);
	return [];
}
