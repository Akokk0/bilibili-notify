/**
 * `collectImageRefs`:一份作品里用到的全部图库引用(㉑d)。出图器事先把它们都解析成地址,漏收一处,
 * 那一处的图永远画占位 —— 而且是静默的(类型、构建全绿),所以每个装引用的格各钉一条。
 */

import type { ImageRef, Post } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { collectImageRefs } from "../templates/post-refs";

/** 第 `n` 个互不相同的引用(形状合规:64 位十六进制 + 扩展名)。 */
const ref = (n: number): ImageRef => `${n.toString(16).padStart(64, "0")}.png`;

const base = (over: Partial<Post> = {}): Post => ({
	creator: { name: "作者" },
	publishedAt: "2026-10-05T00:00:00.000Z",
	text: "",
	...over,
});

describe("collectImageRefs — 每个装引用的格都收", () => {
	const cases: [string, Partial<Post>, ImageRef[]][] = [
		["作者头像", { creator: { name: "甲", avatar: ref(1) } }, [ref(1)]],
		[
			"正文里链接的小图标与表情图",
			{
				text: "看 [doge]",
				richText: [
					{ kind: "link", text: "看", url: "https://example.invalid", icon: ref(2) },
					{ kind: "emoji", text: " [doge]", image: ref(3) },
				],
			},
			[ref(2), ref(3)],
		],
		[
			"专栏配图",
			{ article: { title: "文", images: [{ ref: ref(4) }, { ref: ref(5) }] } },
			[ref(4), ref(5)],
		],
		[
			"专属内容锁的图标",
			{ locked: { icon: { ref: ref(6) }, title: "锁", hint: "充电" } },
			[ref(6)],
		],
		["图集", { images: [{ ref: ref(7) }, { url: "https://example.invalid/x.png" }, {}] }, [ref(7)]],
		["视频封面", { video: { cover: { ref: ref(8) }, title: "v", description: "" } }, [ref(8)]],
		[
			"附加块 card 的封面与文字行图标",
			{
				attachment: {
					kind: "card",
					title: "预约",
					cover: { ref: ref(9) },
					lines: [{ text: "a", icon: ref(10) }, { text: "b" }],
				},
			},
			[ref(9), ref(10)],
		],
		[
			"附加块 video 的封面",
			{ attachment: { kind: "video", title: "v", cover: { ref: ref(11) } } },
			[ref(11)],
		],
		[
			"附加块 goods 每件商品的封面",
			{
				attachment: {
					kind: "goods",
					items: [
						{ cover: { ref: ref(12) }, name: "a" },
						{ cover: { ref: ref(13) }, name: "b" },
					],
				},
			},
			[ref(12), ref(13)],
		],
	];

	for (const [name, over, expected] of cases) {
		it(name, () => {
			expect([...collectImageRefs(base(over))].sort()).toEqual([...expected].sort());
		});
	}

	it("被转发的原作品里的引用一并收(逐层往下)", () => {
		const inner = base({ creator: { name: "原", avatar: ref(20) }, images: [{ ref: ref(21) }] });
		const middle = base({ images: [{ ref: ref(22) }], repost: inner });
		const outer = base({ creator: { name: "外", avatar: ref(23) }, repost: middle });
		expect([...collectImageRefs(outer)].sort()).toEqual(
			[ref(20), ref(21), ref(22), ref(23)].sort(),
		);
	});

	it("同一个引用出现几次只收一份;只有网址的图与什么都没有的图不收;空作品是空集", () => {
		const post = base({
			creator: { name: "甲", avatar: ref(30) },
			images: [{ ref: ref(30) }, { url: "https://example.invalid/a.png" }, {}],
		});
		expect([...collectImageRefs(post)]).toEqual([ref(30)]);
		expect(collectImageRefs(base()).size).toBe(0);
	});
});
