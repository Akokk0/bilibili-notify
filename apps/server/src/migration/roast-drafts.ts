import { t as serverText } from "./i18n.js";
/**
 * 待审的锐评草稿 `runtime/roast-drafts.json`:0.x 按 uid 回指一位 UP → 按订阅 id 回指(ADR-0020 决策 18)。
 * 收进来之前是草稿库读盘时翻(⑥c),草稿库开机只认最新的形状。
 */

import { isPlainObject, readJsonFile, rewriteJsonFile } from "./files.js";
import type { BiliSubscriptionKey } from "./subscriptions.js";

/** 老草稿里的一条,带着「按 uid 回指一位 UP」的那一格。 */
type WithLegacyUid<T> = T & { uid?: unknown; subscriptionId?: unknown };

/**
 * 一份老草稿(按 uid 记)→ 新形状;对不上订阅回一句为什么丢。已经是新形状的原样放行。
 *
 * - 单人:草稿的 `uid` 与结果的 `uid` 都换成那条订阅的 id。
 * - 榜单:鸽王 / 勤奋 UP 任一对不上 → 整份丢(同 `parseRoastReply`:卡的主体缺一半没什么可发的);锐评与
 *   评分里对不上的那几条丢掉,其余照发。
 */
export function upgradeLegacyDraft(
	raw: Record<string, unknown>,
	idOf: (uid: string) => string | undefined,
): Record<string, unknown> | string {
	const lookup = (uid: unknown) => (typeof uid === "string" ? idOf(uid) : undefined);
	const result = raw.result as Record<string, unknown> | null | undefined;
	if (raw.kind === "solo") {
		if (raw.uid === undefined) return raw;
		const { uid, ...rest } = raw;
		const subscriptionId = lookup(uid);
		if (!subscriptionId)
			return serverText("service.migration.roast-drafts.text.1", { value0: String(uid) });
		const { uid: _resultUid, ...resultRest } = (result ?? {}) as Record<string, unknown>;
		return { ...rest, subscriptionId, result: { ...resultRest, subscriptionId } };
	}
	const pigeon = result?.pigeon as WithLegacyUid<{ reason: string }> | undefined;
	if (!result || pigeon?.uid === undefined) return raw;
	const swap = <T extends object>(
		item: WithLegacyUid<T>,
	): (T & { subscriptionId: string }) | null => {
		const { uid, ...rest } = item;
		const subscriptionId = lookup(uid);
		return subscriptionId ? ({ ...rest, subscriptionId } as T & { subscriptionId: string }) : null;
	};
	const diligent = result.diligent as WithLegacyUid<{ reason: string }> | undefined;
	const newPigeon = swap(pigeon);
	const newDiligent = diligent ? swap(diligent) : null;
	if (!newPigeon || !newDiligent) return serverText("service.migration.roast-drafts.text.2");
	const list = (key: "roast" | "scores") =>
		(Array.isArray(result[key]) ? (result[key] as WithLegacyUid<object>[]) : []).flatMap((r) => {
			const one = swap(r);
			return one ? [one] : [];
		});
	return {
		...raw,
		result: {
			...result,
			pigeon: newPigeon,
			diligent: newDiligent,
			roast: list("roast"),
			scores: list("scores"),
		},
	};
}

/**
 * 新代里的草稿迁成最新的形状,回改写过的文件(绝对路径)。uid 找回的是**第一条**同 uid 的 B 站订阅(改之前
 * 按 uid 找订阅也是取第一条)。对不上的草稿丢掉 —— 草稿 48 小时就过期,丢一份顶多少发一份周报。
 *
 * 不是对象的、翻的时候抛错的(手改坏了的)也当对不上丢 —— 从前读盘时这里一抛,这一份连同后面的都没读进来。
 * 文件读不懂、不是数组的原样留着,草稿库开机时照旧当空的起。
 */
export async function migrateRoastDraftsFile(
	path: string,
	subscriptions: readonly BiliSubscriptionKey[],
): Promise<string[]> {
	const file = await readJsonFile(path);
	if (file.kind !== "ok" || !Array.isArray(file.value)) return [];
	const idOf = (uid: string) => subscriptions.find((s) => s.uid === uid)?.id;
	const next = file.value.flatMap((raw: unknown) => {
		if (!isPlainObject(raw)) return [];
		try {
			const upgraded = upgradeLegacyDraft(raw, idOf);
			return typeof upgraded === "string" ? [] : [upgraded];
		} catch {
			return [];
		}
	});
	if (JSON.stringify(next) === JSON.stringify(file.value)) return [];
	await rewriteJsonFile(path, next);
	return [path];
}
