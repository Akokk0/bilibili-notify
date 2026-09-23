/**
 * 宿主收候选那道闸的**照抄**:`SubscriptionCandidatesSchema`
 * (`packages/internal/src/schema/extension-subscription.ts`)加上建订阅时 `decodeSubscriptionAvatar`
 * 的魔数核对(`apps/server/src/runtime/sub-avatar-store.ts`)。
 *
 * 为什么是抄的:拓展连测试也只准从 `@bilibili-notify/extension` 拿 BN 的东西 —— import 边界守卫扫的是
 * `extensions/` 底下**每一个** `.ts`,测试也在内 —— 那两份够不到。那头改了上限,这里要跟着改。
 */

/** 一次最多几条、id / 名字 / 头像的上限 —— 数字照抄宿主。 */
const MAX_CANDIDATES = 20;
const MAX_ID = 256;
const MAX_NAME = 128;
const MAX_AVATAR_CHARS = 128 * 1024;
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const KEYS = new Set(["id", "name", "avatar", "fans"]);

/** 那三种位图开头的几个字节。只看魔数,不解码 —— 宿主也只做到这一步。 */
function magicMatches(type: string, bytes: Buffer): boolean {
	switch (type) {
		case "png":
			return bytes
				.subarray(0, 8)
				.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		case "jpeg":
			return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
		case "webp":
			return (
				bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
				bytes.subarray(8, 12).toString("latin1") === "WEBP"
			);
		default:
			return false;
	}
}

/** 宿主会挑的毛病,每条「第几个.哪一格: 为什么」。空表 = 收下。 */
export function hostComplaints(raw: unknown): string[] {
	if (!Array.isArray(raw)) return ["不是数组"];
	const out: string[] = [];
	if (raw.length > MAX_CANDIDATES) out.push(`多于 ${MAX_CANDIDATES} 条`);
	const seen = new Set<unknown>();
	raw.forEach((one: Record<string, unknown>, i) => {
		for (const key of Object.keys(one)) if (!KEYS.has(key)) out.push(`${i}: 多了 ${key}`);
		const { id, name, avatar, fans } = one;
		if (typeof id !== "string" || id.length < 1 || id.length > MAX_ID) out.push(`${i}.id`);
		if (seen.has(id)) out.push(`${i}.id 重复`);
		seen.add(id);
		if (typeof name !== "string" || name.length < 1 || name.length > MAX_NAME) {
			out.push(`${i}.name`);
		}
		if (fans !== undefined && !(Number.isInteger(fans) && (fans as number) >= 0)) {
			out.push(`${i}.fans`);
		}
		if (avatar !== undefined) {
			const url = typeof avatar === "string" ? avatar : "";
			const match = AVATAR_RE.exec(url);
			if (!match || url.length > MAX_AVATAR_CHARS) {
				out.push(`${i}.avatar 不是位图 data URL`);
			} else {
				const bytes = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
				if (!magicMatches(match[1] as string, bytes)) out.push(`${i}.avatar 魔数对不上`);
			}
		}
	});
	return out;
}
