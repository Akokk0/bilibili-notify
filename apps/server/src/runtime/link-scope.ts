/**
 * 链接解析的生效范围 —— 把配置里的白名单解析成「哪些群算数」。
 *
 * 白名单引用的是推送目标(`PushTarget.id`),入站帧带的却是 `平台 + adapterId + 群地址`;
 * 两边在这里对上。结果是一个允许集,键与解析器给冷却表用的 scope 键同一个格式
 * ({@link linkScopeKey}),解析器拿到消息只做一次 `has`。
 *
 * 谁进允许集,规则全在这儿:只认群类目标;停用的目标或停用 / 不存在的适配器不算
 * (与周报发送时的「跳过」同一条判定,见 `config/target-pause.ts`);引用的目标已经删掉
 * 就当没写。`all` 模式回 `null` = 不限,连目标表都不看 —— 机器人在的所有群都算。
 */

import type { LinkParsingConfig, PushAdapter, PushTarget } from "@bilibili-notify/internal";
import { isTargetPaused } from "../config/target-pause.js";

/** 一个群在链接解析里的身份:平台、来自哪条连接、群地址(OneBot 群号 / 官机群 openid)。 */
export function linkScopeKey(platform: string, adapterId: string, groupId: string): string {
	return `${platform}:${adapterId}:${groupId}`;
}

export interface ResolveLinkParsingScopeInput {
	config: Pick<LinkParsingConfig, "scope" | "targets">;
	targets: readonly PushTarget[];
	adapters: readonly PushAdapter[];
}

/** `null` = 所有群都算;否则只有集合里的群算,空集就是一个群都不算。 */
export function resolveLinkParsingScope({
	config,
	targets,
	adapters,
}: ResolveLinkParsingScopeInput): ReadonlySet<string> | null {
	if (config.scope === "all") return null;

	const byId = new Map(targets.map((t) => [t.id, t]));
	const allowed = new Set<string>();
	for (const { targetId } of config.targets) {
		const target = byId.get(targetId);
		if (target?.scope !== "group" || isTargetPaused(target, adapters)) continue;
		const groupId = groupAddressOf(target);
		if (groupId) allowed.add(linkScopeKey(target.platform, target.adapterId, groupId));
	}
	return allowed;
}

/** 群目标的地址 —— 与入站帧里 `groupId` 同一个值。没有入站的平台(webhook)没有地址。 */
function groupAddressOf(target: PushTarget): string | undefined {
	switch (target.platform) {
		case "onebot":
			return target.session.groupId;
		case "qq-official":
			return target.session.groupOpenid;
		default:
			return undefined;
	}
}
