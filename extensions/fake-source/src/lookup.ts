import { createHash } from "node:crypto";
import type { ExtensionSubscriptionCandidate } from "@bilibili-notify/extension";
import { FAKE_AVATARS, FAKE_SVG } from "./avatars.js";

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
 * 「乱」交回的那一串:拓展的 bug,宿主必须拒(502「候选不合规矩」,逐条点名)。两处毛病各一条,
 * 面板上那句原因会列出两样 —— SVG 头像是最该拦的(同源的 SVG 被直接打开会跑脚本,ADR-0019
 * 决策 49),负的粉丝数是最朴素的那种。
 */
const MESSY_CANDIDATES: readonly ExtensionSubscriptionCandidate[] = [
	{
		id: "fake-mess-svg",
		name: "乱 · SVG 头像",
		avatar: `data:image/svg+xml;base64,${Buffer.from(FAKE_SVG).toString("base64")}`,
	},
	{ id: "fake-mess-fans", name: "乱 · 粉丝数是负的", fans: -1 },
];

/**
 * 解析门。普通的字现编三个候选;四个魔法词各演一种宿主要接住的样子(清单里那句
 * `lookupPlaceholder` 告诉主人有这四个)。
 */
export function fakeLookup(
	query: string,
	signal: AbortSignal,
): readonly ExtensionSubscriptionCandidate[] | Promise<readonly ExtensionSubscriptionCandidate[]> {
	switch (query) {
		case "慢":
			// 平台卡住了 —— 宿主等满 15 秒回面板 504,同时中止 signal。
			return untilAborted(signal);
		case "空":
			// 认不出任何人 —— 面板说「没找到」。
			return [];
		case "坏":
			// 平台那头出错 —— 宿主把原话接在「拓展查询出错:」后面(502)。话要像真的平台毛病。
			throw new Error("cookie 已过期,平台要求重新登录(这是假源在演「平台出错」)");
		case "乱":
			return MESSY_CANDIDATES;
		default:
			return fakeCandidates(query);
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
 * 普通的字 → 三个候选,**同一句字永远是同一组**(id、头像、粉丝数都从它的摘要里取):
 * 主人删了重建、或者两个标签页各查一次,拿到的是同一个「人」。
 *
 * 三个各缺一样,面板那三种样子一次看全:有头像有粉丝、有头像不报粉丝、没头像只报粉丝。
 * id 是摘要的前 16 位加一个字母,再长的查询也只有二十来字(宿主上限 256)。
 */
export function fakeCandidates(query: string): ExtensionSubscriptionCandidate[] {
	const digest = createHash("sha256").update(query).digest("hex");
	const seed = Number.parseInt(digest.slice(0, 8), 16);
	const idOf = (tag: string) => `fake-${digest.slice(0, 16)}-${tag}`;
	const avatarAt = (offset: number) =>
		FAKE_AVATARS[(seed + offset) % FAKE_AVATARS.length] as string;
	const shown = clip(query, NAME_QUERY_MAX);
	return [
		{ id: idOf("a"), name: shown, avatar: avatarAt(0), fans: seed % 100_000 },
		{ id: idOf("b"), name: `${shown}(小号 · 不报粉丝)`, avatar: avatarAt(1) },
		{ id: idOf("c"), name: `${shown}(粉丝站 · 没头像)`, fans: (seed >>> 8) % 5_000_000 },
	];
}
