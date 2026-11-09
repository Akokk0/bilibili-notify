import { fail, type Issue, issuesFromZod, ok, type Result } from "@bilibili-notify/internal";
import type { ZodType } from "zod";
import { t as serverText } from "../i18n/index.js";

/**
 * 连接的 `settings` 归适配器的 `settingsSchema`:盘上存的是原文(不补默认值),用之前由宿主按
 * 适配器的规则解一遍 —— **递到适配器手上的连接,`settings` 一律是解过的输出**,适配器只认键、不再自己解。
 *
 * 「某条连接的设置过不过得了它适配器的规则」取决于此刻哪些适配器在场(拓展拨一下开关就来去),
 * 所以不存成标记,每次用的时候现算 —— 判断只有这一份。
 */

/** 按一份 settingsSchema 解 settings。过了回解过的值(补了默认值);不过回 `invalid` + 逐条原因。 */
export function resolveSettings(schema: ZodType, settings: unknown): Result<{ settings: unknown }> {
	const parsed = schema.safeParse(settings);
	if (parsed.success) return ok({ settings: parsed.data });
	const issues = issuesFromZod(parsed.error);
	return fail("invalid", settingsIssueMessage(issues), { issues });
}

/**
 * 一句给人看的话:「设置不合法：<哪一格>：<第一条原因>」。日志与派发器的失败话用它;
 * 面板红字拿 `settingsIssues` 自己拼,写法与这里同一个样子(`apps/web/src/services/error-text.ts`)。
 */
export function settingsIssueMessage(issues: readonly Issue[]): string {
	const first = issues[0];
	if (!first) return serverText("service.push.connection-settings.text.1");
	const reason =
		first.path && first.path.length > 0
			? serverText("settings.problem.reason", {
					field: first.path.join("."),
					message: first.message,
				})
			: first.message;
	return serverText("service.push.connection-settings.text.2", {
		reason,
	});
}

/**
 * 下发打码与备份脱敏「问得出来吗」的共用入口(`routes/secret-view.ts` 与 `backup/sanitize.ts` 吃同一份)。
 * 凭据所在的格子从两处问:适配器的 `settingsSchema` 上的 `secret` 标记,以及拓展在字段表 /
 * 清单里声明成密钥的键 —— 拓展的 schema 上没有标记,只看前者会让拓展在场时一格都不打码。
 */
export interface SecretCellsReader {
	/** 在场的适配器的 settingsSchema(内置的带 markSecret / markBackupOnly 标记);不在场回 undefined。 */
	settingsSchemaOf(adapterKey: string): ZodType | undefined;
	/** 拓展在字段表 / 清单里声明成密钥的 settings 键;问不出来回 undefined；按 schema 标记读的集成由装配交 []。 */
	declaredSecretKeysOf(adapterKey: string): readonly string[] | undefined;
}

/**
 * 这条连接的密钥键「问不出来」吗 —— 下发打码与备份脱敏共用的一份判断。
 * 拓展(非内置)适配器的 schema 上没有 `secret` 标记,密钥只靠它声明的键认;声明问不出来(清单读不了 /
 * 版本不合)时按标记走等于一格都不遮,所以从严:下发整格遮挡、备份整片抹空。
 * 回 `[]` 是问得出来、没有额外声明；按 schema 标记读的集成也由装配交 `[]`。
 */
export function secretsUnaskable(lookup: SecretCellsReader, adapterKey: string): boolean {
	return lookup.declaredSecretKeysOf(adapterKey) === undefined;
}

/**
 * 造一份查表:适配器的 schema 现取登记表(适配器会来去,不存快照),拓展声明的键由调用方给
 * (`index.ts` 里是装载器的 `secretConfigCodes()`)。不给 = 一个键都问不出来。
 */
export function createSecretCellsReader(
	adapters: { list(): readonly { adapterKey: string; settingsSchema: ZodType }[] },
	declaredSecretKeysOf: (adapterKey: string) => readonly string[] | undefined = () => undefined,
): SecretCellsReader {
	return {
		settingsSchemaOf: (adapterKey) =>
			adapters.list().find((a) => a.adapterKey === adapterKey)?.settingsSchema,
		declaredSecretKeysOf,
	};
}
