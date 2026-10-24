import { IMAGE_REF_PATTERN } from "./harness.js";

/**
 * 宿主收候选那道闸的**照抄**:`ExtensionCreatorCandidatesSchema`
 * (`packages/internal/src/schema/extension-report.ts`)。
 *
 * 为什么是抄的:拓展连测试也只准从 `@bilibili-notify/extension` 拿 BN 的东西 —— import 边界守卫扫的是
 * `extensions/` 底下**每一个** `.ts`,测试也在内 —— 那份够不到。那头改了上限,这里要跟着改。
 */

/** 一次最多几条、externalId / 名字 / 简介的上限 —— 数字照抄宿主。 */
const MAX_CANDIDATES = 10;
const MAX_ID = 256;
const MAX_NAME = 128;
const MAX_BIO = 10_000;
const KEYS = new Set(["externalId", "name", "avatar", "bio", "followers", "fanClubName"]);

/** 宿主会挑的毛病,每条「第几个.哪一格: 为什么」。空表 = 收下。 */
export function hostComplaints(raw: unknown): string[] {
	if (!Array.isArray(raw)) return ["不是数组"];
	const out: string[] = [];
	if (raw.length > MAX_CANDIDATES) out.push(`多于 ${MAX_CANDIDATES} 条`);
	const seen = new Set<unknown>();
	raw.forEach((one: Record<string, unknown>, i) => {
		for (const key of Object.keys(one)) if (!KEYS.has(key)) out.push(`${i}: 多了 ${key}`);
		const { externalId, name, avatar, bio, followers } = one;
		if (typeof externalId !== "string" || externalId.length < 1 || externalId.length > MAX_ID) {
			out.push(`${i}.externalId`);
		}
		if (seen.has(externalId)) out.push(`${i}.externalId 重复`);
		seen.add(externalId);
		if (typeof name !== "string" || name.length < 1 || name.length > MAX_NAME) {
			out.push(`${i}.name`);
		}
		if (bio !== undefined && (typeof bio !== "string" || bio.length > MAX_BIO)) {
			out.push(`${i}.bio`);
		}
		if (followers !== undefined && !(Number.isInteger(followers) && (followers as number) >= 0)) {
			out.push(`${i}.followers`);
		}
		if (avatar !== undefined && !(typeof avatar === "string" && IMAGE_REF_PATTERN.test(avatar))) {
			out.push(`${i}.avatar 不是图库引用`);
		}
	});
	return out;
}
