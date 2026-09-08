import { createHash, timingSafeEqual } from "node:crypto";
import type { Connection } from "@bilibili-notify/internal";

/**
 * 这条 token 是哪条桥接入的 —— 认不出就是 `null`。
 *
 * **比对恒定时间**:这是未鉴权的外来输入第一次碰到配置,拿 `===` 撸一遍连接表等于按响应
 * 快慢把 token 一个字节一个字节地漏出去。比的是两边的 SHA-256 摘要而不是原文:摘要恒 32
 * 字节,于是「长度不同」这件事也不外泄(`timingSafeEqual` 本身对不等长直接抛)。找到了也
 * **不提前退出**,比对次数只跟连接条数有关。
 *
 * 「认得」不等于「现在收」:停用的接入照样认得出来 —— 那一层由 `BridgeServerOptions.accepts`
 * 判,它回 503 而不是 401,插件据此退避重连而不是当成配置错。
 */
export function resolveBridgeToken(
	connections: readonly Connection[],
	token: string,
): string | null {
	const given = digest(token);
	let matched: string | null = null;
	for (const connection of connections) {
		if (connection.kind !== "bridge") continue;
		// 空 token 存得下(脱敏备份把它抹成空串,存不回去等于备份恢复不了),但**永远不许
		// 匹配** —— 否则恢复回来的那条接入谁都能连。这个分支只看配置、不看来人,不漏时序。
		if (connection.config.token === "") continue;
		if (timingSafeEqual(digest(connection.config.token), given) && matched === null) {
			matched = connection.id;
		}
	}
	return matched;
}

function digest(value: string): Buffer {
	return createHash("sha256").update(value, "utf8").digest();
}
