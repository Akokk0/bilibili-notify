/** 面板回归测试使用真实适配器候选和规则描述,不再另抄默认值。 */
import {
	type NewConnection,
	type OnebotConnectionSettings,
	OnebotConnectionSettingsSchema,
	type OnebotTransport,
	QQOfficialConnectionSettingsSchema,
	settingsFieldsFromSchema,
	WebhookConnectionSettingsSchema,
} from "@bilibili-notify/internal";
import { builtinCandidatesFor } from "../../../../server/src/platforms/builtin-candidates";
import { connectionSettingsFields } from "../connection-fields";
import { connectionFromCandidate } from "../domain";

export function descriptorsOf(connection: Pick<NewConnection, "adapterKey">) {
	const schema = (
		{
			onebot: OnebotConnectionSettingsSchema,
			"qq-official": QQOfficialConnectionSettingsSchema,
			webhook: WebhookConnectionSettingsSchema,
		} as Record<string, unknown>
	)[connection.adapterKey];
	return schema ? settingsFieldsFromSchema(schema, { connection: true }) : [];
}
export function makeEmptyConnection(platform: string, name: string) {
	for (const key of ["onebot", "qq-official", "webhook"]) {
		const candidate = builtinCandidatesFor(key).find(
			(candidate) => candidate.platform.platform === platform,
		);
		if (candidate) return connectionFromCandidate(key, candidate, name);
	}
	throw new Error(`Unknown fixture platform ${platform}`);
}
export function connectionFields(connection: NewConnection) {
	return connectionSettingsFields(connection, descriptorsOf(connection));
}
export function switchOnebotTransport(
	settings: OnebotConnectionSettings,
	transport: OnebotTransport,
): OnebotConnectionSettings {
	const connection = { ...makeEmptyConnection("onebot", ""), settings };
	const selector = connectionFields(connection).find(
		(field) => "code" in field && field.code === "settings.transport",
	);
	if (selector?.kind !== "chips") throw new Error("Missing transport selector");
	return selector.set(transport).settings as OnebotConnectionSettings;
}
export function webhookUrlPlaceholder(platform: string) {
	const field = connectionFields(makeEmptyConnection(platform, "")).find(
		(field) => "code" in field && field.code === "settings.url",
	);
	return field?.kind === "text" ? field.placeholder : undefined;
}
export function webhookSecretHint(platform: string) {
	const field = connectionFields(makeEmptyConnection(platform, "")).find(
		(field) => "code" in field && field.code === "settings.secret",
	);
	return field && "hint" in field ? field.hint : undefined;
}

export const builtinAdapters = [
	{
		key: "onebot",
		descriptor: {
			label: "OneBot v11",
			shortLabel: "OneBot",
			color: "#3b82f6",
			settingsFields: descriptorsOf({ adapterKey: "onebot" }),
		},
		has: { connectionAuth: false, listAddressCandidates: false },
	},
	{
		key: "qq-official",
		descriptor: {
			auth: { description: "扫码在腾讯页面一键创建机器人", experimental: true },
			label: "QQ 官方机器人",
			shortLabel: "QQ官方",
			color: "#14b8a6",
			settingsFields: descriptorsOf({ adapterKey: "qq-official" }),
		},
		has: { connectionAuth: true, listAddressCandidates: true },
	},
	{
		key: "webhook",
		descriptor: {
			label: "Webhook",
			shortLabel: "Webhook",
			color: "#94a3b8",
			settingsFields: descriptorsOf({ adapterKey: "webhook" }),
		},
		has: { connectionAuth: false, listAddressCandidates: false },
	},
];
export function builtinCandidatesResponse(url: string) {
	const key = /^\/api\/adapters\/([^/]+)\/candidates$/.exec(url)?.[1];
	return key && builtinAdapters.some((entry) => entry.key === key)
		? { candidates: builtinCandidatesFor(key) }
		: undefined;
}
