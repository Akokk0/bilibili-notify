import type { BackupKind } from "./backup-file";

/** 一次导入实际写了什么(dryRun 下是「将会写什么」)。与后端 ImportResult 同形。 */
export interface ImportResult {
	subscriptions: { upserted: number; deleted: number };
	adapters: { upserted: number; deleted: number };
	targets: { upserted: number; deleted: number };
	globalsApplied: boolean;
	cookiesRestored: boolean;
}

/** 这次导入碰到的段里,有没有「凭据被抹空」的东西。 */
function blankedCredentials(r: ImportResult): string[] {
	return [
		// 适配器的 appSecret / accessToken / webhook secret 全被脱敏抹成空串。
		r.adapters.upserted > 0 ? "适配器密钥" : null,
		// 全局设置里的 defaults.ai.apiKey 同理。
		r.globalsApplied ? "AI API Key" : null,
	].filter((x): x is string => x !== null);
}

/**
 * 把导入回执写成一句人话。
 *
 * 脱敏档要额外交代一句「凭据是空的」——否则用户看到「导入完成:适配器 1 项」,以为
 * 大功告成,结果推送悄无声息:适配器在、开关也开着,就是没密钥。这个因果链没人猜得到。
 * 只在这次真的导入了带凭据的段时才提示,免得喊狼来了。
 */
export function summarizeImport(r: ImportResult, kind: BackupKind): string {
	const scope = (label: string, s: { upserted: number; deleted: number }) =>
		s.upserted || s.deleted
			? `${label} ${s.upserted} 项${s.deleted ? `、删除 ${s.deleted} 项` : ""}`
			: null;
	const parts = [
		scope("订阅", r.subscriptions),
		scope("推送目标", r.targets),
		scope("适配器", r.adapters),
		r.globalsApplied ? "全局设置已应用" : null,
		r.cookiesRestored ? "B 站登录已恢复" : null,
	].filter(Boolean);

	const head =
		parts.length > 0 ? `导入完成：${parts.join(" · ")}` : "导入完成：备份内容与当前一致，无改动";

	const blanked = kind === "sanitized" ? blankedCredentials(r) : [];
	return blanked.length > 0 ? `${head}。脱敏备份不含凭据，需重新填写：${blanked.join("、")}` : head;
}
