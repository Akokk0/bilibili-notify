/**
 * 拓展报的作品 → 平台中立的作品(ADR-0019 决策 55 / 66 / 69 / 71 / 72 / 77;卡的翻译见 `post-from-report.test.ts`)。
 *
 * 装配(`deliverWork`)只认 `NeutralWork` 那几格。这里钉的是「拓展交的那张表」翻过去之后每一格从哪来:
 * 卡是出卡时才翻成 `Post` 交给出图器的 `generatePostCard`(作者名、头像引用、样式原样带过去,没出卡就不碰图库)、
 * 链接 / 名字 / 叫法、AI 看的正文与图、过滤看的文字。
 */

import { WORK_COMMENT_IMAGES_MAX } from "@bilibili-notify/dynamic";
import type { ImageRenderer } from "@bilibili-notify/image";
import type { Post as NeutralPost, SubscriptionReportValue } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { png } from "../../__tests__/support/report-images.js";
import {
	extensionPostFilterText,
	extensionPostWork,
	POST_COMMENT_IMAGE_MAX_BYTES,
} from "../extension-post-work.js";
import type { PostImageSink } from "../post-from-report.js";

type Post = SubscriptionReportValue<"post">;

const AVATAR_REF = `${"a".repeat(63)}1.png`;
const PUT_REF = `${"b".repeat(63)}1.png`;

/** 本机时区的 2026-09-24 12:00:05。 */
const PUBLISHED = new Date(2026, 8, 24, 12, 0, 5).getTime();

const dataUrl = (mime: string, bytes: Uint8Array) =>
	`data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

function post(over: Partial<Post> = {}): Post {
	return {
		id: "p1",
		url: "https://www.douyin.com/video/p1",
		publishedAt: PUBLISHED,
		...over,
	};
}

/** 存什么都成功、都回同一个引用的口;`put` 留着看有没有被调。 */
function sink() {
	const put = vi.fn(async (_bytes: Uint8Array) => ({ ok: true as const, ref: PUT_REF }));
	return { images: { put } satisfies PostImageSink, put };
}

const OPTS = { authorName: "作者甲", images: sink().images };

describe("卡:出卡时才翻成 Post,交给出图器的 generatePostCard", () => {
	/** 出一次卡,截下交给出图器的 Post 与样式。 */
	async function render(p: Post, colors: Record<string, unknown> = {}, over = {}) {
		const seen: { post?: NeutralPost; colors?: unknown } = {};
		const image = {
			generatePostCard: async (translated: NeutralPost, c: unknown) => {
				seen.post = translated;
				seen.colors = c;
				return Buffer.from("card");
			},
		} as unknown as ImageRenderer;
		const card = await extensionPostWork(p, { ...OPTS, ...over }).renderCard(image, colors);
		expect(card.toString()).toBe("card");
		if (!seen.post) throw new Error("renderCard 没把 Post 交给出图器");
		return { post: seen.post, colors: seen.colors };
	}

	it("作者名与订阅资料里的头像引用原样上 Post(取法见 extension-posts / extension-push-common)", async () => {
		const { post: translated } = await render(
			post({ text: "正文" }),
			{},
			{ profileAvatar: AVATAR_REF },
		);
		expect(translated).toMatchObject({
			creator: { name: "作者甲", avatar: AVATAR_REF },
			text: "正文",
		});
	});

	it("事件带来的配图经图库的口存,Post 里放的是它回的引用", async () => {
		const { images, put } = sink();
		const bytes = png(10, 10);
		const { post: translated } = await render(post({ images: [bytes] }), {}, { images });
		expect(put).toHaveBeenCalledWith(bytes);
		expect(translated.images).toEqual([expect.objectContaining({ ref: PUT_REF })]);
	});

	it("装配给的样式与皮肤原样交给出图器", async () => {
		const { colors } = await render(post(), { cardSkin: "my-skin", font: "某字体" });
		expect(colors).toEqual({ cardSkin: "my-skin", font: "某字体" });
	});

	it("没出卡就不翻、不碰图库(关了出图、版式藏起卡片时不白写盘)", () => {
		const { images, put } = sink();
		const work = extensionPostWork(post({ images: [png(10, 10)], author: { avatar: png(8, 8) } }), {
			...OPTS,
			images,
		});
		expect(work.commentText).toBe("");
		expect(put).not.toHaveBeenCalled();
	});

	it("存图的口抛错(磁盘写失败):renderCard 跟着抛,由装配降级成纯文字", async () => {
		const images: PostImageSink = {
			put: async () => {
				throw new Error("磁盘满了");
			},
		};
		const image = { generatePostCard: async () => Buffer.from("card") } as unknown as ImageRenderer;
		await expect(
			extensionPostWork(post({ images: [png(10, 10)] }), { ...OPTS, images }).renderCard(image, {}),
		).rejects.toThrow("磁盘满了");
	});
});

describe("装配要的那几格", () => {
	it("链接是事件的 url;名字取作者名;没有图集(决策 72);叫法缺省「动态」,给了照用", () => {
		const work = extensionPostWork(post(), OPTS);
		expect(work).toMatchObject({
			link: "https://www.douyin.com/video/p1",
			name: "作者甲",
			isVideo: false,
			postNoun: "动态",
			gallery: [],
		});
		expect(extensionPostWork(post(), { ...OPTS, postNoun: "作品" }).postNoun).toBe("作品");
		expect(extensionPostWork(post({ video: {} }), OPTS).isVideo).toBe(true);
	});

	it("AI 的正文 = 作品正文 +「视频标题：…」;拼不出字就是空串(不点评)", () => {
		const text = (p: Post) => extensionPostWork(p, OPTS).commentText;
		expect(text(post({ text: "今天发新歌", video: { title: "新歌 MV" } }))).toBe(
			"今天发新歌\n视频标题：新歌 MV",
		);
		expect(text(post({ text: "只有正文" }))).toBe("只有正文");
		expect(text(post({ video: { title: "只有标题" } }))).toBe("视频标题：只有标题");
		expect(text(post({ text: "   " }))).toBe("");
	});

	it("AI 的图 = 作品图 + 视频封面,前 4 张;单张太大就跳过,让后面的顶上", () => {
		const small = [1, 2, 3].map((i) => png(8, 8, i));
		const huge = png(8, 8, 9, POST_COMMENT_IMAGE_MAX_BYTES + 1);
		const cover = png(8, 8, 7);
		const work = extensionPostWork(
			post({ images: [small[0], huge, small[1], small[2]] as Uint8Array[], video: { cover } }),
			OPTS,
		);
		expect(work.commentImages).toEqual([
			...small.map((b) => dataUrl("image/png", b)),
			dataUrl("image/png", cover),
		]);
		const many = extensionPostWork(
			post({ images: Array.from({ length: 6 }, (_, i) => png(8, 8, i)) }),
			OPTS,
		);
		// 张数上限就是装配(deliverWork)用的那一个数,不另抄一份。
		expect(many.commentImages).toHaveLength(WORK_COMMENT_IMAGES_MAX);
	});

	it("AI 的图点评真要看时才编,而且只编一次", () => {
		const work = extensionPostWork(post({ images: [png(8, 8, 1)] }), OPTS);
		expect(work.commentImages).toBe(work.commentImages);
	});
});

describe("过滤看的文字(决策 70)", () => {
	it("作品正文 + 视频标题;都没有是空串", () => {
		expect(extensionPostFilterText(post({ text: "正文", video: { title: "标题" } }))).toBe(
			"正文\n标题",
		);
		expect(extensionPostFilterText(post({ video: { title: "标题" } }))).toBe("标题");
		expect(extensionPostFilterText(post())).toBe("");
	});
});
