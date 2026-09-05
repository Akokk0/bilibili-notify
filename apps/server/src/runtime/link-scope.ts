/**
 * 链接解析的逐群答案 —— 把「默认行 + 逐群例外」对上入站帧里的群。
 *
 * 例外引用的是推送目标(`PushTarget.id`),入站帧带的却是 `平台 + adapterId + 群地址`;
 * 两边在这里对上。结果是一张表,键与解析器给冷却表用的 scope 键同一个格式
 * ({@link linkScopeKey}),解析器拿到消息只做一次 `policyFor`。
 *
 * 谁怎么算,规则全在这儿:只认群类目标;停用的目标或停用 / 不存在的适配器一律不解析
 * (与周报发送时的「跳过」同一条判定,见 `config/target-pause.ts`;默认行开着、例外显式
 * 开着都压不过它);例外引用的目标已经删掉就当没写;不是推送目标的群没有 id,跟默认行;
 * 同一个群配成了两个目标时先出现的那个说了算。
 */

import {
	type LinkParsingConfig,
	type LinkParsingPolicy,
	linkParsingFor,
	type PushAdapter,
	type PushTarget,
} from "@bilibili-notify/internal";
import { isTargetPaused } from "../config/target-pause.js";

/** 一个群在链接解析里的身份:平台、来自哪条连接、群地址(OneBot 群号 / 官机群 openid)。 */
export function linkScopeKey(platform: string, adapterId: string, groupId: string): string {
	return `${platform}:${adapterId}:${groupId}`;
}

export interface LinkPolicyTable {
	/** 一个群折叠后的答案。陌生群(不是推送目标)拿默认行。 */
	policyFor(key: string): LinkParsingPolicy;
}

export interface ResolveLinkParsingPoliciesInput {
	config: Pick<LinkParsingConfig, "defaults" | "groups">;
	targets: readonly PushTarget[];
	adapters: readonly PushAdapter[];
}

export function resolveLinkParsingPolicies({
	config,
	targets,
	adapters,
}: ResolveLinkParsingPoliciesInput): LinkPolicyTable {
	const byKey = new Map<string, LinkParsingPolicy>();
	for (const target of targets) {
		if (target.scope !== "group") continue;
		const groupId = groupAddressOf(target);
		if (!groupId) continue;
		const key = linkScopeKey(target.platform, target.adapterId, groupId);
		if (byKey.has(key)) continue;
		const policy = linkParsingFor(config, target.id);
		byKey.set(key, { ...policy, parse: policy.parse && !isTargetPaused(target, adapters) });
	}
	const stranger: LinkParsingPolicy = linkParsingFor(config, undefined);
	return { policyFor: (key) => byKey.get(key) ?? stranger };
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
