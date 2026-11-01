import type { ConnectionSettingsField, NewConnection } from "@bilibili-notify/internal";
import { settingsAreMasked } from "./connection-credentials";

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
			kind: "listener-address";
			/** 这条连接监听的那个端口。主机名由面板按浏览器地址栏现算 —— 服务端不知道自己被怎么访问。 */
			port: number;
	  };

export function connectionSettingsFields(
	connection: NewConnection,
	fields: readonly ConnectionSettingsField[],
): ConnectionField[] {
	if (settingsAreMasked(connection)) return [];
	const bag = (
		typeof connection.settings === "object" && connection.settings !== null
			? connection.settings
			: {}
	) as Record<string, unknown>;
	const put = (key: string, v: unknown): NewConnection => ({
		...connection,
		settings: { ...bag, [key]: v },
	});
	const visible = fields.filter((field) => !field.when || bag[field.when.key] === field.when.value);
	const result = visible.map((original): ConnectionField => {
		const field = { ...original, ...original.byPlatform?.[connection.platform] };
		const base = {
			code: `settings.${field.key}`,
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
					secret: field.secret && !field.monospace,
					credential: field.secret,
					set: (v) => put(field.key, v || (field.secret && !field.required ? undefined : "")),
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
					kind: field.variants ? "chips" : "select",
					value: typeof raw === "string" ? raw : (field.default ?? field.options[0]?.value ?? ""),
					options: field.options,
					set: (v: string) => {
						const variant =
							field.variants && Object.hasOwn(field.variants, v) ? field.variants[v] : undefined;
						if (!variant) return put(field.key, v);
						const settings = structuredClone(variant.settings) as Record<string, unknown>;
						for (const cell of variant.preserve) {
							const value = bag[cell.key];
							if (cell.truthy ? !!value : value !== undefined) settings[cell.key] = value;
						}
						return { ...connection, settings };
					},
				};
			case "record":
				return {
					...base,
					kind: "headers",
					value:
						typeof raw === "object" && raw !== null && !Array.isArray(raw)
							? (raw as Record<string, string>)
							: (field.default ?? {}),
					set: (v) => put(field.key, v),
				};
			default: {
				// 配置项加了新 type 而这里没接 —— 编译期就该红,别悄悄画成空白。
				const never: never = field;
				throw new Error(`unknown extension field type: ${JSON.stringify(never)}`);
			}
		}
	});
	return result.flatMap((field, index) => {
		if (field.kind === "number" && visible[index]?.listener)
			return [field, { kind: "listener-address", port: field.value }] as ConnectionField[];
		return [field];
	});
}
