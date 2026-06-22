/**
 * koishi-bot 平台容错解析。
 *
 * 解决 master 私聊「目标不可达」根因:master 的 `botPlatform` 来自 master 配置里
 * 单独的下拉框,与订阅项的 `item.platform` 是两个配置源。用户常在 master 里选了
 * `qq`,但实际跑的是 onebot(NapCat/Lagrange/go-cqhttp,koishi 里 `bot.platform`
 * 为 `"onebot"`)→ 精确匹配找不到 bot → 群能发、私聊主人却永远不可达。
 *
 * 三段式:
 *   - **exact**:配置平台(+selfId)匹配到 bot(无论在线与否)→ 用它,**不回退**。
 *     「平台对但暂时离线」不应被导向别的平台账号(userId 命名空间不同会发错人)。
 *   - **fallback**:配置平台**完全没有**对应 bot,但当前在线 bot 只有唯一一个平台
 *     → 用那个在线 bot(消除单 bot 部署下的误选)。
 *   - **ambiguous / none**:在线平台有多个(不瞎猜)或没有任何在线 bot → 不给 bot。
 */

/** koishi `Bot` 的最小解析视图 —— 只读解析需要的三个字段,便于纯函数单测。 */
export interface BotLike {
	platform: string;
	selfId: string;
	status: number;
}

export type ResolveReason = "exact" | "fallback" | "ambiguous" | "none";

export interface BotResolution<T extends BotLike = BotLike> {
	/** 解析到的 bot;ambiguous / none 时为 undefined。 */
	bot?: T;
	reason: ResolveReason;
	/** 当前在线 bot 的去重平台列表 —— 供告警提示用户实际可用的平台。 */
	onlinePlatforms: string[];
}

/** 精确匹配:平台相等,且 selfId 为空时匹配任意 selfId,否则要求 selfId 相等。 */
function matchesExact(b: BotLike, botPlatform: string, selfId?: string): boolean {
	return b.platform === botPlatform && (!selfId || selfId === "" || b.selfId === selfId);
}

export function resolveKoishiBot<T extends BotLike>(
	bots: readonly T[],
	cfg: { botPlatform: string; selfId?: string },
	onlineStatus: number,
): BotResolution<T> {
	const onlinePlatforms = [
		...new Set(bots.filter((b) => b.status === onlineStatus).map((b) => b.platform)),
	];

	// 精确匹配:同平台(+selfId)可能有多个 bot(多账号部署)。优先挑在线的那个,
	// 避免「首个恰好离线」被 .find 取中 → isAvailable 误判不可达。全离线时返回首个,
	// 让 isAvailable 如实报离线(仍不回退到别的平台)。
	const matching = bots.filter((b) => matchesExact(b, cfg.botPlatform, cfg.selfId));
	if (matching.length > 0) {
		const online = matching.find((b) => b.status === onlineStatus);
		return { bot: online ?? matching[0], reason: "exact", onlinePlatforms };
	}

	if (onlinePlatforms.length === 1) {
		const bot = bots.find((b) => b.status === onlineStatus);
		return { bot, reason: "fallback", onlinePlatforms };
	}
	if (onlinePlatforms.length > 1) {
		return { reason: "ambiguous", onlinePlatforms };
	}
	return { reason: "none", onlinePlatforms };
}

/**
 * 把非 exact 的解析结果翻成一条可操作告警;exact 返回 null(无需告警)。
 * `label` 标识是哪条 target(如 "master"),`botPlatform` 是用户在配置里选的平台。
 */
export function botResolutionWarning(
	label: string,
	botPlatform: string,
	res: Pick<BotResolution, "reason" | "onlinePlatforms">,
): string | null {
	if (res.reason === "exact") return null;
	const avail = res.onlinePlatforms.length > 0 ? res.onlinePlatforms.join(", ") : "(无)";
	const onebotHint = "提示:NapCat / Lagrange / go-cqhttp 等 OneBot 实现的平台名是 onebot,不是 qq。";
	if (res.reason === "fallback") {
		const used = res.onlinePlatforms[0];
		return `[${label}] 配置的推送平台是 "${botPlatform}",但未找到该平台的机器人;已回退使用当前唯一在线的 "${used}" 投递。建议把 ${label} 平台改成 "${used}"。${onebotHint}`;
	}
	if (res.reason === "ambiguous") {
		return `[${label}] 配置的推送平台是 "${botPlatform}",但未找到该平台的机器人;当前在线平台有 [${avail}],无法自动确定该用哪个。请把 ${label} 平台改成其中之一。${onebotHint}`;
	}
	return `[${label}] 配置的推送平台是 "${botPlatform}",但当前没有任何在线机器人,运行状态通知将无法送达。请检查机器人是否在线,以及平台是否选对。${onebotHint}`;
}
