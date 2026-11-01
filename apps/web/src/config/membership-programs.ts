import type { MembershipProgram, MembershipTier } from "@bilibili-notify/internal";

export type { MembershipProgram, MembershipTier };

/** 描述符声明的体系档位,按实际 rank 升序;不修改来源数组。 */
export function membershipTiersOf(
	programs: readonly MembershipProgram[] | undefined,
	programId: string,
): MembershipTier[] {
	const program = programs?.find((p) => p.id === programId);
	return program && Array.isArray(program.tiers)
		? [...program.tiers].sort((a, b) => a.rank - b.rank)
		: [];
}

export function membershipTierOf(
	programs: readonly MembershipProgram[] | undefined,
	programId: string,
	key: string,
): MembershipTier | undefined {
	return membershipTiersOf(programs, programId).find((tier) => tier.key === key);
}
