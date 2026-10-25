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
 * 要整份换 settings,官机扫码回填还要补显示名),页面不用知道。
 */

import type { ExtensionScalarField } from "@bilibili-notify/contract";
import type {
	NewConnection,
	OnebotConnectionSettings,
	OnebotTransport,
	QQOfficialBotType,
	QQOfficialConnectionSettings,
	WebhookConnectionSettings,
	WebhookPlatform,
} from "@bilibili-notify/internal";
import {
	isWebhookPlatform,
	ONEBOT_FORWARD_MIN_TIMEOUT_MS,
	ONEBOT_IMAGE_MIN_TIMEOUT_MS,
} from "@bilibili-notify/internal/platform-registry";
import { settingsAreMasked } from "./connection-credentials";
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
			/**
			 * 下发时是打码的凭据格(ADR-0021 决策 44):已存着的画成「遮挡胶囊 + 换一份」,不是输入框。
			 * 与 `secret`(输入时画成点)是两件事 —— webhook 的地址是凭据,但输入时要看得见。
			 */
			credential?: boolean;
			set: (v: string) => NewConnection;
	  })
	| (FieldBase & {
			kind: "number";
			value: number;
			min?: number;
			max?: number;
			step?: number;
			suffix?: string;
			width?: number;
			set: (v: number) => NewConnection;
	  })
	| (FieldBase & { kind: "toggle"; value: boolean; set: (v: boolean) => NewConnection })
	| (FieldBase & {
			kind: "select";
			value: string;
			options: ReadonlyArray<{ value: string; label: string }>;
			set: (v: string) => NewConnection;
	  })
	/** 「一排里选一个」的胶囊。与 select 的差别只在长相 —— 连法那一排要用平台标识色。 */
	| (FieldBase & {
			kind: "chips";
			value: string;
			options: ReadonlyArray<{ value: string; label: string }>;
			set: (v: string) => NewConnection;
	  })
	| (FieldBase & {
			kind: "headers";
			value: Record<string, string>;
			set: (v: Record<string, string>) => NewConnection;
	  })
	/**
	 * 反向 WS 那条「bot 该连哪儿」—— 不是一栏字段,是一行印出来的地址加一颗复制钮。
	 *
	 * 🔴 **非印不可**(issue #49):反向 WS 是 bot 主动连进来,这条地址从前只活在我们脑子里,
	 * 面板只让填一个端口号。从 koishi 转过来的人(那边默认推荐 `ws://127.0.0.1:5140/onebot`)
	 * 因此以为路径没地方写,只好在 bot 那侧另开一个服务端改走正向 WS —— 而路径其实一直
	 * 是自由的:监听那头 `WebSocketServer({ port })` 不带 `path`,什么路径都收。
	 */
	| {
			kind: "ws-reverse-address";
			/** 这条连接监听的那个端口。主机名由面板按浏览器地址栏现算 —— 服务端不知道自己被怎么访问。 */
			port: number;
	  }
	/** 官机的扫码建号行 —— 不是一栏字段,是一整行说明加一颗按钮。 */
	| {
			kind: "qq-bind";
			/** 发起扫码的适配器键(`/api/adapters/:adapterKey/auth…`),取自这条连接。 */
			adapterKey: string;
			/** 扫出来的凭据 → 整条新连接(顺手归好域 / 沙箱、补上空着的显示名)。 */
			apply: (creds: { appId: string; appSecret: string }) => NewConnection;
	  };

/** OneBot 的三种连法。 */
const ONEBOT_TRANSPORTS: ReadonlyArray<{ value: OnebotTransport; label: string }> = [
	{ value: "http", label: "HTTP" },
	{ value: "ws", label: "正向 WS" },
	{ value: "ws-reverse", label: "反向 WS" },
];

function onebotFields(connection: NewConnection): ConnectionField[] {
	const cfg = connection.settings as OnebotConnectionSettings;
	const setCfg = (next: OnebotConnectionSettings): NewConnection => ({
		...connection,
		settings: next,
	});
	const patch = (over: Partial<OnebotConnectionSettings>): NewConnection =>
		setCfg({ ...cfg, ...over } as OnebotConnectionSettings);

	const fields: ConnectionField[] = [
		{
			kind: "chips",
			code: "settings.transport",
			label: "连接方式",
			required: true,
			value: cfg.transport,
			options: ONEBOT_TRANSPORTS,
			// 整份换掉 settings(branch schema 是 strict,不能留上一档的残字段),共用字段留着。
			set: (v) => setCfg(switchOnebotTransport(cfg, v as OnebotTransport)),
		},
	];

	if (cfg.transport === "http") {
		fields.push({
			kind: "text",
			code: "settings.baseUrl",
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
			code: "settings.url",
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
			code: "settings.port",
			label: "反向 WS 监听端口",
			hint: "bot 主动连入此端口;端口即身份,与主端口 8787 独立",
			min: 1,
			max: 65_535,
			width: 120,
			value: cfg.port,
			set: (v) => setCfg({ ...cfg, port: v }),
		});
		fields.push({ kind: "ws-reverse-address", port: cfg.port });
	}

	fields.push({
		kind: "text",
		code: "settings.accessToken",
		label: "accessToken",
		secret: true,
		credential: true,
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
			code: "settings.timeoutMs",
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
			code: "settings.imageMinTimeoutMs",
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
			code: "settings.mergeForwardMinTimeoutMs",
			label: "合并转发超时下限",
			hint: `语义同上，只是合并转发要把每张图逐张下载再上传组装，更慢（默认 ${ONEBOT_FORWARD_MIN_TIMEOUT_MS / 1000}s）。填 0 = 不放宽`,
			min: 0,
			step: 1000,
			suffix: "ms",
			width: 120,
			value: cfg.mergeForwardMinTimeoutMs,
			set: (v) => patch({ mergeForwardMinTimeoutMs: v }),
		},
		{
			kind: "number",
			code: "settings.maxRetries",
			label: "重试次数",
			hint: "不含首次,失败后再尝试",
			min: 0,
			max: 10,
			suffix: "次",
			value: cfg.maxRetries,
			set: (v) => patch({ maxRetries: v }),
		},
		{
			kind: "number",
			code: "settings.retryIntervalMs",
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
			code: "settings.headers",
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

function qqOfficialFields(connection: NewConnection): ConnectionField[] {
	const cfg = connection.settings as QQOfficialConnectionSettings;
	const setCfg = (next: QQOfficialConnectionSettings): NewConnection => ({
		...connection,
		settings: next,
	});
	return [
		{
			kind: "qq-bind",
			adapterKey: connection.adapterKey,
			// 回填 = 「用扫出来的这个 lite bot」,顺手把域 / 沙箱归到它的正确档:lite bot 无原生
			// markdown 特权,留在私域档会让图集推送必败。显示名称为空时补默认名 —— 扫码流程
			// 跳过了表单上半截,名称空着会让保存钮一直灰着(唯一前端必填),用户看不出为什么存不了。
			apply: ({ appId, appSecret }) => ({
				...connection,
				name: connection.name.trim() ? connection.name : `QQ 机器人 ${appId}`,
				settings: { ...cfg, appId, appSecret, botType: "public", sandbox: false },
			}),
		},
		{
			kind: "text",
			code: "settings.appId",
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
			code: "settings.appSecret",
			label: "AppSecret",
			required: true,
			secret: true,
			credential: true,
			hint: "机器人密钥;用于换取 App Access Token",
			value: cfg.appSecret,
			set: (v) => setCfg({ ...cfg, appSecret: v }),
		},
		{
			kind: "select",
			code: "settings.botType",
			label: "机器人域",
			required: true,
			hint: "私域可发原生 markdown(图集合并成一条多图);公域不支持原生 markdown(图集逐条发,需报备模板)",
			options: QQ_BOT_TYPES,
			value: cfg.botType,
			set: (v) => setCfg({ ...cfg, botType: v as QQOfficialBotType }),
		},
		{
			kind: "toggle",
			code: "settings.sandbox",
			label: "沙箱模式",
			hint: "开启后走 QQ 沙箱环境(sandbox.api.sgroup.qq.com),仅对沙箱内成员可见",
			value: cfg.sandbox,
			set: (v) => setCfg({ ...cfg, sandbox: v }),
		},
		{
			kind: "toggle",
			code: "settings.logReconnects",
			label: "记录重连日志",
			hint: "QQ 官方网关约每 30 分钟主动要求重连一次,属正常协议行为;默认关闭避免刷屏,排障时可开启",
			value: cfg.logReconnects,
			set: (v) => setCfg({ ...cfg, logReconnects: v }),
		},
	];
}

function webhookFields(connection: NewConnection): ConnectionField[] {
	const cfg = connection.settings as WebhookConnectionSettings;
	// 「哪家的机器人」原先是这张表里一个叫「Webhook 协议」的下拉 —— 它现在就是上面那排
	// 平台胶囊,不再问第二遍。webhook 适配器管的连接平台恒在这四个里,认不出落到 generic。
	const platform: WebhookPlatform = isWebhookPlatform(connection.platform)
		? connection.platform
		: "generic";
	const fields: ConnectionField[] = [
		{
			kind: "text",
			code: "settings.url",
			label: "URL",
			required: true,
			mono: true,
			placeholder: webhookUrlPlaceholder(platform),
			credential: true,
			value: cfg.url,
			set: (v) => ({ ...connection, settings: { ...cfg, url: v } }),
		},
		{
			kind: "text",
			code: "settings.secret",
			label: "Secret",
			secret: true,
			credential: true,
			hint: webhookSecretHint(platform),
			value: cfg.secret ?? "",
			set: (v) => ({ ...connection, settings: { ...cfg, secret: v || undefined } }),
		},
	];

	// 自定义请求头**四家都给**(主人拍板要统一)。`settings.headers` 本来就是四家共用的一格,
	// 投递时也确实摊进每一次 POST(`platforms/webhook.ts` 的 `baseHeaders`)——「官方 hook
	// 用不上」只在直连官方地址时成立,一旦谁把它挡在反向代理后面就不成立了,而那种情况
	// 少一栏就等于从面板配不出来。
	fields.push({
		kind: "headers",
		code: "settings.headers",
		label: "自定义请求头",
		hint: "端点挡在反向代理 / Cloudflare Access 后面时要带的鉴权头(如 Authorization)。直连官方地址一般用不上;签名密钥填上面那栏,别写这里",
		value: cfg.headers,
		set: (v) => ({ ...connection, settings: { ...cfg, headers: v } }),
	});
	return fields;
}

/**
 * 拓展连接的表单:拓展交上来的连接配置项(`ExtensionDTO.push.settingsFields`,ADR-0012
 * 决策 33)一栏翻一栏。字段身份带着拓展 id(`ext.<id>.<key>`),与内置平台的字段不撞。
 * 值就落在 `settings[key]`,这一层不认得任何具体拓展。
 *
 * 配置项按**数据类型**分(`string` / `number` / `boolean` / `enum`),这里翻成表单自己按
 * 控件分的那几种(`text` / `number` / `toggle` / `select`)。
 *
 * 🔴 键缺省时先落到字段声明的 `default`,再落到各控件的兜底:键缺省的格存下去,拓展那份
 * zod 补的就是 `default` —— 表单要是画成「关」/ 第一项,屏幕上的和实际生效的就是两个值。
 */
export function extensionConnectionFields(
	connection: NewConnection,
	fields: readonly ExtensionScalarField[],
): ConnectionField[] {
	const bag = (
		typeof connection.settings === "object" && connection.settings !== null
			? connection.settings
			: {}
	) as Record<string, unknown>;
	const put = (key: string, v: unknown): NewConnection => ({
		...connection,
		settings: { ...bag, [key]: v },
	});
	return fields.map((field): ConnectionField => {
		const base = {
			code: `ext.${connection.adapterKey}.${field.key}`,
			label: field.label,
			hint: field.description,
			required: field.required,
		};
		const raw = bag[field.key];
		switch (field.type) {
			case "string":
				return {
					...base,
					kind: "text",
					value: typeof raw === "string" ? raw : (field.default ?? ""),
					placeholder: field.placeholder,
					mono: field.monospace,
					secret: field.secret,
					set: (v) => put(field.key, v),
				};
			case "number":
				return {
					...base,
					kind: "number",
					value: typeof raw === "number" ? raw : (field.default ?? field.min ?? 0),
					min: field.min,
					max: field.max,
					step: field.step,
					suffix: field.unit,
					set: (v) => put(field.key, v),
				};
			case "boolean":
				return {
					...base,
					kind: "toggle",
					value: typeof raw === "boolean" ? raw : (field.default ?? false),
					set: (v) => put(field.key, v),
				};
			case "enum":
				return {
					...base,
					kind: "select",
					value: typeof raw === "string" ? raw : (field.default ?? field.options[0]?.value ?? ""),
					options: field.options,
					set: (v) => put(field.key, v),
				};
			default: {
				// 配置项加了新 type 而这里没接 —— 编译期就该红,别悄悄画成空白。
				const never: never = field;
				throw new Error(`unknown extension field type: ${JSON.stringify(never)}`);
			}
		}
	});
}

/**
 * 这条连接的配置该摆哪几栏。
 *
 * 桥接入眼下给空表 —— 它的参数(BN 地址 + token)在拓展页那侧填,不走这张连接表单。
 * 认不出的也给空表:页面那一侧不用再写一句兜底。
 */
export function connectionFields(connection: NewConnection): ConnectionField[] {
	// 整格是遮挡的(适配器没在跑 / 设置不合法)没有表单可画,也不许往里加键。
	if (settingsAreMasked(connection)) return [];
	switch (connection.adapterKey) {
		case "onebot":
			return onebotFields(connection);
		case "qq-official":
			return qqOfficialFields(connection);
		case "webhook":
			return webhookFields(connection);
		default:
			return [];
	}
}
