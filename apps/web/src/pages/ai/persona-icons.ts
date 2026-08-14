/**
 * 内置人格的图标。
 *
 * 主人自己加的性格用通用的小人像;四份**内置**的各有各的样子 —— 它们是主人一眼要
 * 认出「哪个是哪个」的那几份,清一色小人像等于没图标。
 *
 * 只存**图标名**不存渲染好的元素:这样这份映射是纯数据,可以直接写测试守住
 * 「内置预设加了一份却没人画图标」——那种事在界面上得盯着看才发现得了。
 */

import type { Icon } from "@bilibili-notify/ui";

export type IconKey = keyof typeof Icon;

/**
 * 内置四份各自的图标。键取自 `packages/internal` 的 `DEFAULT_AI.presets`,
 * 一致性由 `__tests__/persona-icons.test.ts` 守着(漏画 / 多余 / 撞图都会红)。
 */
export const BUILTIN_PERSONA_ICONS: Record<string, IconKey> = {
	// 温柔、体贴、轻声细语 —— 心形在这里读的是「贴心」。
	"gentle-maid": "heart",
	// 嘴硬心软、毒舌、爱用反问 —— 火气在外面,是这一份最好认的特征。
	tsundere: "fire",
	// 冷静干练、信息优先,输出是「亮点 / 关键信息 / 简评」三段式 —— 算清楚了再报。
	analyst: "calculator",
	// 活泼、热情。太阳比 sparkle 更贴:后者像「闪一下」,这一份要的是一整天都亮着。
	genki: "sun",
};

/** 通用的那个:主人新加的、以及老配置迁移出来的「我的性格」都用它。 */
const FALLBACK: IconKey = "user";

export function personaIconKey(presetId: string): IconKey {
	return BUILTIN_PERSONA_ICONS[presetId] ?? FALLBACK;
}
