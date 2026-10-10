import { type ConnectionCandidate, PLATFORM_REGISTRY } from "@bilibili-notify/internal";

/**
 * 内置适配器的候选:平台注册表里归这个适配器的那几行(OneBot 一行、QQ 官方一行、webhook 四行)。
 * 三个内置适配器共用这一份取法,描述只住注册表,不在适配器里手抄。
 */
export function builtinCandidatesFor(adapterKey: string): readonly ConnectionCandidate[] {
	return Object.entries(PLATFORM_REGISTRY)
		.filter(([, row]) => row.adapterKey === adapterKey)
		.map(([platform, { adapterKey: _adapterKey, ...snapshot }]) => ({
			platform: { platform, ...snapshot },
		}));
}
