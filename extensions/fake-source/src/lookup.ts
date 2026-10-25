import { createHash } from "node:crypto";
import { type CreatorCandidate, fail, ok, type Result } from "@bilibili-notify/extension";
import { FAKE_AVATARS } from "./avatars.js";
import { BAD_IMAGE_REF, type StorePicture } from "./reports.js";

/**
 * 名字里最多带多少字的查询词。宿主收的名字是 1–128 字,而查询最长能到 1024 —— 截短了
 * 再拼上后缀,长查询也不会让整次解析变成「候选不合规矩」。
 */
const NAME_QUERY_MAX = 100;

/** 截到 `max` 个 UTF-16 单元,不把代理对劈成半个(半个 emoji 画出来是问号方块)。 */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	let head = text.slice(0, max - 1);
	const last = head.charCodeAt(head.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
	return `${head}…`;
}

/**
 * 「乱」交回的那一串:拓展的 bug,宿主必须拒(`invalid`,逐条点名)。两处毛病各一条,面板上那句原因会列出
 * 两样 —— 头像不是图库引用的形状(第 3 版里头像是图库引用,不再有「SVG 头像」可混:SVG 字节在 `storeImage`
 * 那一步就被图库拒了),负的粉丝数是最朴素的那种。
 */
const MESSY_CANDIDATES: readonly CreatorCandidate[] = [
	{ externalId: "fake-mess-avatar", name: "乱 · 头像不是图库引用", avatar: BAD_IMAGE_REF },
	{ externalId: "fake-mess-followers", name: "乱 · 粉丝数是负的", followers: -1 },
];

/**
 * 搜人。普通的字现编三个候选;四个魔法词各演一种宿主要接住的样子(拓展视图的
 * `view.notice` 告诉主人有这四个)。失败回结果形状,不抛。
 *
 * `store` 是来源起来之后才有的(`ctx.storeImage`);候选头像先存进图库、交引用。
 */
export function fakeSearchCreators(
	store: StorePicture,
	query: string,
	signal: AbortSignal,
): Promise<Result<{ candidates: CreatorCandidate[] }>> {
	switch (query) {
		case "慢":
			// 平台卡住了 —— 宿主等满 15 秒回面板 504,同时中止 signal。
			return untilAborted(signal);
		case "空":
			// 认不出任何人 —— 面板说「没找到」(成功的空表)。
			return Promise.resolve(ok({ candidates: [] }));
		case "坏":
			// 平台那头出错 —— 宿主把原话接在「拓展查询出错:」后面(502)。话要像真的平台毛病。
			return Promise.resolve(
				fail("unauthorized", "cookie 已过期,平台要求重新登录(这是假源在演「平台出错」)"),
			);
		case "乱":
			return Promise.resolve(ok({ candidates: [...MESSY_CANDIDATES] }));
		default:
			return fakeCandidates(store, query).then(
				(candidates) => ok({ candidates }),
				// 图库存不下头像:照实回失败,不抛。
				(err: unknown) => fail("unavailable", err instanceof Error ? err.message : String(err)),
			);
	}
}

/**
 * 一直不回,直到 `signal` 中止;中止时按它的 `reason` 拒掉。**不起定时器** —— 等多久是宿主的事,
 * 自己计时的话,宿主不等了之后那只定时器没人清。
 */
function untilAborted(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

/**
 * 普通的字 → 三个候选,**同一句字永远是同一组**(id、头像、粉丝数都从它的摘要里取;头像的图库引用是内容的
 * 摘要,同一张图永远是同一个引用):主人删了重建、或者两个标签页各查一次,拿到的是同一个「人」。
 *
 * 三个各缺一样,面板那三种样子一次看全:有头像有粉丝、有头像不报粉丝、没头像只报粉丝。
 * id 是摘要的前 16 位加一个字母,再长的查询也只有二十来字(宿主上限 256)。
 */
export async function fakeCandidates(
	store: StorePicture,
	query: string,
): Promise<CreatorCandidate[]> {
	const digest = createHash("sha256").update(query).digest("hex");
	const seed = Number.parseInt(digest.slice(0, 8), 16);
	const idOf = (tag: string) => `fake-${digest.slice(0, 16)}-${tag}`;
	const avatarAt = (offset: number) =>
		store(FAKE_AVATARS[(seed + offset) % FAKE_AVATARS.length] as Uint8Array);
	const shown = clip(query, NAME_QUERY_MAX);
	return [
		{
			externalId: idOf("a"),
			name: shown,
			avatar: await avatarAt(0),
			followers: seed % 100_000,
		},
		{ externalId: idOf("b"), name: `${shown}(小号 · 不报粉丝)`, avatar: await avatarAt(1) },
		{
			externalId: idOf("c"),
			name: `${shown}(粉丝站 · 没头像)`,
			followers: (seed >>> 8) % 5_000_000,
		},
	];
}
