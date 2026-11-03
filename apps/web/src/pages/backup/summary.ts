import type { ImportResult } from "@bilibili-notify/contract";
import { i18n } from "../../i18n";
import type { BackupKind } from "./backup-file";

// ImportResult 的单一来源在 @bilibili-notify/contract(server 同源消费)。
export type { ImportResult };

/** 这次导入碰到的段里,有没有「凭据被抹空」的东西。 */
function blankedCredentials(r: ImportResult): string[] {
	return [
		// 连接的 appSecret / accessToken / webhook secret 全被脱敏抹成空串。
		r.connections.upserted > 0 ? i18n.t("panelUi.pages.backup.summary.1") : null,
		// 全局设置里的 ai.apiKey 同理。
		r.globalsApplied ? "AI API Key" : null,
	].filter((x): x is string => x !== null);
}

/** 备份里有、但没带回来的集成:点名键与原因,多个用顿号隔开;没有就不出这一句。 */
function unrestoredNote(unrestored: ImportResult["unrestoredIntegrations"]): string | null {
	if (unrestored.length === 0) return null;
	const named = unrestored.map((u) => `${u.key}（${u.message}）`).join("、");
	return i18n.t("panelUi.pages.backup.summary.2", { count: unrestored.length, value1: named });
}

/**
 * 把导入回执写成一句人话。
 *
 * 脱敏档要额外交代一句「凭据是空的」——否则用户看到「导入完成:连接 1 项」,以为
 * 大功告成,结果推送悄无声息:连接在、开关也开着,就是没密钥。这个因果链没人猜得到。
 * 只在这次真的导入了带凭据的段时才提示,免得喊狼来了。
 */
export function summarizeImport(r: ImportResult, kind: BackupKind): string {
	const scope = (label: string, s: { upserted: number; deleted: number }) =>
		s.upserted || s.deleted
			? i18n.t("panelUi.pages.backup.summary.3", {
					value0: label,
					count: s.upserted,
					value2: s.deleted ? i18n.t("panelUi.pages.backup.summary.4", { count: s.deleted }) : "",
				})
			: null;
	const parts = [
		scope(i18n.t("panelUi.pages.backup.summary.5"), r.subscriptions),
		scope(i18n.t("panelUi.pages.backup.summary.6"), r.targets),
		scope(i18n.t("panelUi.pages.backup.summary.7"), r.connections),
		r.globalsApplied ? i18n.t("panelUi.pages.backup.summary.8") : null,
		// 句子按个数中立地说(服务端回的是集成键);3a-28 有了集成的描述之后换成名字。
		r.restoredIntegrations.length > 0
			? i18n.t("panelUi.pages.backup.summary.9", { count: r.restoredIntegrations.length })
			: null,
		unrestoredNote(r.unrestoredIntegrations),
	].filter(Boolean);

	const head =
		parts.length > 0
			? i18n.t("panelUi.pages.backup.summary.10", { value0: parts.join(" · ") })
			: i18n.t("panelUi.pages.backup.summary.11");

	const blanked = kind === "sanitized" ? blankedCredentials(r) : [];
	return blanked.length > 0
		? i18n.t("panelUi.pages.backup.summary.12", { value0: head, value1: blanked.join("、") })
		: head;
}
