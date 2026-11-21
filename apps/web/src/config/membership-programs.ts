import type { MembershipProgram, MembershipTier } from "@bilibili-notify/internal";

export type { MembershipProgram, MembershipTier };

function sortedTiers(program: MembershipProgram | undefined): MembershipTier[] {
	return program && Array.isArray(program.tiers)
		? [...program.tiers].sort((a, b) => a.rank - b.rank)
		: [];
}

/** 描述符声明的体系档位,按实际 rank 升序;不修改来源数组。 */
export function membershipTiersOf(
	programs: readonly MembershipProgram[] | undefined,
	programId: string,
): MembershipTier[] {
	return sortedTiers(programs?.find((p) => p.id === programId));
}

/** 只有声明了固定档位的体系才有门槛可选，未配置门槛时取最低档。 */
export function rankedMembershipPrograms(programs: readonly MembershipProgram[]) {
	return programs.flatMap((program) => {
		const tiers = sortedTiers(program);
		const lowest = tiers[0];
		return lowest ? [{ program, tiers, lowestRank: lowest.rank }] : [];
	});
}

export function membershipTierOf(
	programs: readonly MembershipProgram[] | undefined,
	programId: string,
	key: string,
): MembershipTier | undefined {
	return membershipTiersOf(programs, programId).find((tier) => tier.key === key);
}
