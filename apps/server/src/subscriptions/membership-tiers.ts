import type { MembershipProgram, MembershipTier } from "@bilibili-notify/internal";
import type { SourceRegistry } from "./registry.js";

/**
 * 会员档位的读口:各来源在描述符里声明的体系,按（体系 id, 档 key）找、或取一套体系里最低一档。
 * 体系 id 全局唯一(登记时拒收撞的),档 key 只在体系内唯一 —— 所以查档必须带体系 id。
 */
export interface MembershipTierReader {
	/**
	 * 在这个体系里按键找档;体系不在册、或它的档位由主播自定(`custom`)= undefined。
	 * 不给体系 id 时按登记先后在全部体系里找第一个(旧请求没有这一格,保留它今天的找法)。
	 */
	byKey(programId: string | undefined, key: string): MembershipTier | undefined;
	/**
	 * 某一套声明了档位(`tiers` 是非空数组)的体系里 rank 最小的一档;不给体系 id 时取第一套这样的体系
	 * (示例卡与「没带 key 的预览」用它)。
	 */
	lowest(programId?: string): MembershipTier | undefined;
}

/** 每次调用现读登记表:来源后登记、被撤下,读到的跟着变。`tiers: "custom"` 的体系声明不了档,跳过。 */
export function createMembershipTierReader(
	sources: Pick<SourceRegistry, "list">,
): MembershipTierReader {
	/** 全部声明了的体系,按登记先后。 */
	const programs = (): MembershipProgram[] => {
		const out: MembershipProgram[] = [];
		for (const view of sources.list()) {
			for (const program of view.descriptor.membershipPrograms ?? []) {
				out.push(program);
			}
		}
		return out;
	};
	const lowestOf = (tiers: MembershipTier[]): MembershipTier | undefined =>
		tiers.reduce<MembershipTier | undefined>(
			(min, tier) => (min === undefined || tier.rank < min.rank ? tier : min),
			undefined,
		);
	return {
		byKey(programId, key) {
			for (const program of programs()) {
				if (programId !== undefined && program.id !== programId) continue;
				if (!Array.isArray(program.tiers)) continue;
				const found = program.tiers.find((tier) => tier.key === key);
				if (found !== undefined) return found;
			}
			return undefined;
		},
		lowest(programId) {
			if (programId !== undefined) {
				const program = programs().find((candidate) => candidate.id === programId);
				if (program === undefined || !Array.isArray(program.tiers)) return undefined;
				return lowestOf(program.tiers);
			}
			for (const program of programs()) {
				if (Array.isArray(program.tiers) && program.tiers.length > 0) {
					return lowestOf(program.tiers);
				}
			}
			return undefined;
		},
	};
}
