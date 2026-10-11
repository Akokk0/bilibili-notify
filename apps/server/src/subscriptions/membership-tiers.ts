import type { MembershipTier } from "@bilibili-notify/internal";
import type { SourceRegistry } from "./registry.js";

/** 会员档位的读口:各来源在描述符里声明的体系,按档的 key 找、或取最低一档。 */
export interface MembershipTierReader {
	/** 按档的 key 在全部在册来源声明的体系里找档,按登记先后取第一个;找不到 = undefined。 */
	byKey(key: string): MembershipTier | undefined;
	/** 第一套声明了档位(`tiers` 是非空数组)的体系里 rank 最小的那一档;示例卡与「没带 key 的预览」用它。 */
	lowest(): MembershipTier | undefined;
}

/** 每次调用现读登记表:来源后登记、被撤下,读到的跟着变。`tiers: "custom"` 的体系声明不了档,跳过。 */
export function createMembershipTierReader(
	sources: Pick<SourceRegistry, "list">,
): MembershipTierReader {
	/** 全部声明了档位的体系的档数组,按登记先后。 */
	const declaredTiers = (): MembershipTier[][] => {
		const out: MembershipTier[][] = [];
		for (const view of sources.list()) {
			for (const program of view.descriptor.membershipPrograms ?? []) {
				if (Array.isArray(program.tiers) && program.tiers.length > 0) out.push(program.tiers);
			}
		}
		return out;
	};
	return {
		byKey(key) {
			for (const tiers of declaredTiers()) {
				const found = tiers.find((tier) => tier.key === key);
				if (found) return found;
			}
			return undefined;
		},
		lowest() {
			const first = declaredTiers()[0];
			if (!first) return undefined;
			return first.reduce((min, tier) => (tier.rank < min.rank ? tier : min));
		},
	};
}
