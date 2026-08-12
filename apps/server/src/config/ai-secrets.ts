/**
 * AI 密钥与 globals.json 之间的唯一通道。
 *
 * 「按实例分桶」之后密钥不再是一把,而是**每个实例桶两把** —— 主模型的
 * `apiKey` 与看图副模型的 `vision.apiKey`(副模型常在另一家,DeepSeek 没有视觉
 * 模型,跨厂商是常态)。
 *
 * 三个函数配成一套:
 *
 * - {@link collectAiSecrets} 收集要存进加密袋的
 * - {@link stripAiSecrets} 落盘前把明文抠掉(`state/globals.json` **不加密**)
 * - {@link applyAiSecrets} 读回时从袋子灌回内存,引擎照旧读得到
 *
 * 三者必须互为逆运算:`apply(strip(g), collect(g))` 恒等于 `g`。破了这条就意味着
 * 「重启一次配置就掉一部分」,而这种故障看着像「配置丢了」,极难溯源。
 *
 * **袋子的键是自描述的路径**(`"<实例id>"` / `"<实例id>:vision"`),而不是固定的
 * 一批字段名:添加实例时这里自动跟上,不必再改一次数据结构。上一代按服务商分桶
 * 时袋键就是服务商名 —— 迁移刻意保留桶键,袋子无需搬迁。
 */

import type { GlobalConfig } from "@bilibili-notify/internal";

/** 视觉副模型那把 key 在袋子里的后缀。 */
const VISION_SUFFIX = ":vision";

/** 一把 AI 密钥在袋子里的键。 */
export function aiSecretKey(profileId: string, vision = false): string {
	return vision ? `${profileId}${VISION_SUFFIX}` : profileId;
}

/**
 * 收集所有非空的 AI 密钥。
 *
 * **空值不进袋**:袋里存个空串等于把「未配置」记成「配置了一个空的」,
 * 而 {@link applyAiSecrets} 回填时两者的表现是一样的,于是这个区别会静默丢失。
 */
export function collectAiSecrets(g: GlobalConfig): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [id, p] of Object.entries(g.defaults.ai.providers)) {
		if (!p) continue;
		if (p.apiKey) out[aiSecretKey(id)] = p.apiKey;
		if (p.vision.apiKey) out[aiSecretKey(id, true)] = p.vision.apiKey;
	}
	return out;
}

/**
 * 落盘前把所有 AI 密钥抠成空串。
 *
 * 抠成空串而不是 `delete` 掉那个键:globals 必须保持 zod parse 后的**规范形态**
 * (键序敏感) —— 引擎的 config-changed diff 是拿 `JSON.stringify` 逐 section 比
 * 相等的,少一个键再补回去会让它落到对象末尾,键序偏移,于是重启后第一次改任何
 * 设置都会被误判成「AI 配置变了」而白热重载一次。
 *
 * 不改动传进来的那份 —— 内存里的明文还要继续给引擎用。
 */
export function stripAiSecrets(g: GlobalConfig): GlobalConfig {
	return mapAiSecrets(g, () => "");
}

/**
 * 从加密袋把密钥灌回内存。
 *
 * 袋里有而 `providers` 里没有的键**一律忽略**:主人删掉一家、袋里却还留着它的
 * key 时会走到这儿,凭空造出桶来会让设置页左栏多一块本该没有的。
 */
export function applyAiSecrets(g: GlobalConfig, bag: Record<string, string>): GlobalConfig {
	return mapAiSecrets(g, (id, vision) => bag[aiSecretKey(id, vision)] ?? "");
}

/** 对每个已存在的桶里的两把 key 各取一次新值。只读入参,返回新对象。 */
function mapAiSecrets(
	g: GlobalConfig,
	next: (profileId: string, vision: boolean) => string,
): GlobalConfig {
	const entries = Object.entries(g.defaults.ai.providers);
	if (entries.length === 0) return g;
	return {
		...g,
		defaults: {
			...g.defaults,
			ai: {
				...g.defaults.ai,
				providers: Object.fromEntries(
					entries.map(([id, p]) => [
						id,
						p && {
							...p,
							apiKey: next(id, false),
							vision: { ...p.vision, apiKey: next(id, true) },
						},
					]),
				),
			},
		},
	};
}
