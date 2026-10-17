/**
 * 链接解析的逐群答案 —— 把「默认行 + 逐群例外」对上入站帧里的群。
 *
 * 例外引用的是推送目标(`PushTarget.id`),入站帧带的却是 `connectionId + 群地址`;
 * 两边在这里对上。结果是一张表,键与解析器给冷却表用的 scope 键同一个格式
 * ({@link linkScopeKey}),解析器拿到消息只做一次 `policyFor`。
 *
 * 谁怎么算,规则全在这儿:只认群类目标;停用的目标或停用 / 不存在的连接一律不解析
 * (与周报发送时的「跳过」同一条判定,见 internal 的 `isTargetPaused`;默认行开着、例外显式
 * 开着都压不过它);例外引用的目标已经删掉就当没写;不是推送目标的群没有 id,跟默认行;
 * 同一个群配成了两个目标时先出现的那个说了算。
 */

import {
	type Connection,
	groupAddressOf,
	isTargetPaused,
	type LinkPreviewPolicy,
	type LinkPreviewSettings,
	linkPreviewFor,
	type PushTarget,
} from "@bilibili-notify/internal";

/**
 * 一个群在链接解析里的身份:来自哪条连接、群地址(OneBot 群号 / 官机群 openid)。
 * 键里没有平台 —— 连接 id 已经说全了是哪个 bot(ADR-0024 决策 9)。只活在内存里,不落盘。
 */
export function linkScopeKey(connectionId: string, address: string): string {
	return `${connectionId}:${address}`;
}

export interface LinkPolicyTable {
	/** 一个群折叠后的答案。陌生群(不是推送目标)拿默认行。 */
	policyFor(key: string): LinkPreviewPolicy;
}

export interface ResolveLinkPreviewPoliciesOptions {
	settings: Pick<LinkPreviewSettings, "isOnByDefault" | "replyForm" | "byTarget">;
	targets: readonly PushTarget[];
	connections: readonly Connection[];
}

export function resolveLinkPreviewPolicies({
	settings,
	targets,
	connections,
}: ResolveLinkPreviewPoliciesOptions): LinkPolicyTable {
	const byKey = new Map<string, LinkPreviewPolicy>();
	for (const target of targets) {
		if (target.kind !== "session" || target.scope !== "group") continue;
		const address = groupAddressOf(target);
		if (!address) continue;
		const key = linkScopeKey(target.connectionId, address);
		if (byKey.has(key)) continue;
		const policy = linkPreviewFor(settings, target.id);
		byKey.set(key, { ...policy, isOn: policy.isOn && !isTargetPaused(target, connections) });
	}
	const stranger: LinkPreviewPolicy = linkPreviewFor(settings, undefined);
	return { policyFor: (key) => byKey.get(key) ?? stranger };
}
