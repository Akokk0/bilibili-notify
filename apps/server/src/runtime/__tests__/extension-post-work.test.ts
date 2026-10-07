/**
 * 拓展报的作品 → 平台中立的作品(ADR-0019 决策 55 / 66 / 69 / 71 / 72 / 77;翻成 `Post` 见 `post-from-report.test.ts`)。
 *
 * 装配(`deliverWork`)只认 `NeutralWork` 那几格。这里钉的是翻好的 `Post` 与上报原件交到手之后每一格从哪来:
 * 卡是出卡那一刻才把推迟的图写进图库、再把**同一份** `Post` 交给出图器的 `generatePostCard`(样式原样带过去,
 * 没出卡就不写盘)、链接 / 名字 / 叫法、AI 看的正文(`postText(post, "labeled")`,取段只此一份)与图。
 * 过滤看的字不在这里了:过滤吃 `Post`,走 `filterPost`(`packages/dynamic`)。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageRenderer } from "@bilibili-notify/image";
import type { Post as NeutralPost, SubscriptionReportValue } from "@bilibili-notify/internal";
import { postText } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { png } from "../../__tests__/support/report-images.js";
import { WORK_COMMENT_IMAGES_MAX } from "../../bilibili/dynamic/index.js";
import { createImageStore, imageRefOf } from "../../images/image-store.js";
import { extensionPostWork, POST_COMMENT_IMAGE_MAX_BYTES } from "../extension-post-work.js";
import { deferImageWrites, type ImageSink, postFromReport } from "../post-from-report.js";

type Reported = SubscriptionReportValue<"post">;

const AVATAR_REF = `${"a".repeat(63)}1.png`;

/** 本机时区的 2026-09-24 12:00:05。 */
const PUBLISHED = new Date(2026, 8, 24, 12, 0, 5).getTime();

const dataUrl = (mime: string, bytes: Uint8Array) =>
	`data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

function post(over: Partial<Reported> = {}): Reported {
	return {
		id: "p1",
		url: "https://www.douyin.com/video/p1",
		publishedAt: PUBLISHED,
		...over,
	};
}

/** 存什么都成功的图库替身,回图库起的那个名字(内容哈希);`put` 留着看有没有被调。 */
function storingPut(order?: string[]) {
	return vi.fn(async (bytes: Uint8Array) => {
		order?.push("put");
		const ref = imageRefOf(bytes);
		if (!ref) throw new Error("夹具图不合规");
		return { ok: true as const, ref };
	});
}
function sink() {
	const put = storingPut();
	return { images: { put } satisfies ImageSink, put };
}

/** 像 `bindExtensionPosts` 那样:先推迟写盘地翻成 Post,再包成中立作品。 */
async function workOf(
	report: Reported,
	over: { postNoun?: string; profileAvatar?: string; images?: ImageSink } = {},
) {
	const deferred = deferImageWrites(over.images ?? sink().images);
	const translated = await postFromReport(report, {
		authorName: "作者甲",
		profileAvatar: over.profileAvatar,
		images: deferred.sink,
	});
	const commit = vi.fn(deferred.commit);
	return {
		work: extensionPostWork(report, translated, { postNoun: over.postNoun, commitImages: commit }),
		translated,
		commit,
	};
}

describe("卡:出卡时才把图写进图库,再把同一份 Post 交给出图器的 generatePostCard", () => {
	/** 出一次卡,截下交给出图器的 Post 与样式。 */
	async function render(report: Reported, colors: Record<string, unknown> = {}, over = {}) {
		const seen: { post?: NeutralPost; colors?: unknown } = {};
		const image = {
			generatePostCard: async (translated: NeutralPost, c: unknown) => {
				seen.post = translated;
				seen.colors = c;
				return Buffer.from("card");
			},
		} as unknown as ImageRenderer;
		const built = await workOf(report, over);
		const card = await built.work.renderCard(image, colors);
		expect(card.toString()).toBe("card");
		if (!seen.post) throw new Error("renderCard 没把 Post 交给出图器");
		return { ...built, post: seen.post, colors: seen.colors };
	}

	it("交给出图器的就是翻好的那一份 Post(作者名、订阅资料里的头像引用都在上面),不再翻第二遍", async () => {
		const { post: handed, translated } = await render(
			post({ text: "正文" }),
			{},
			{ profileAvatar: AVATAR_REF },
		);
		expect(handed).toBe(translated);
		expect(handed).toMatchObject({
			creator: { name: "作者甲", avatar: AVATAR_REF },
			text: "正文",
		});
	});

	it("出卡前先 commit 把图写进图库;Post 里放的是图库的引用", async () => {
		const order: string[] = [];
		const put = storingPut(order);
		const bytes = png(10, 10);
		const image = {
			generatePostCard: async () => {
				order.push("card");
				return Buffer.from("card");
			},
		} as unknown as ImageRenderer;
		const { work, translated } = await workOf(post({ images: [bytes] }), { images: { put } });
		expect(put).not.toHaveBeenCalled(); // 翻译时不写
		expect(translated.images).toEqual([expect.objectContaining({ ref: imageRefOf(bytes) })]);
		await work.renderCard(image, {});
		expect(order).toEqual(["put", "card"]);
		expect(put).toHaveBeenCalledWith(bytes);
	});

	it("装配给的样式与皮肤原样交给出图器", async () => {
		const { colors } = await render(post(), { cardSkin: "my-skin", font: "某字体" });
		expect(colors).toEqual({ cardSkin: "my-skin", font: "某字体" });
	});

	it("没出卡就不碰图库(被屏蔽、关了出图、版式藏起卡片时不白写盘)", async () => {
		const { images, put } = sink();
		const { work, commit } = await workOf(
			post({ images: [png(10, 10)], author: { avatar: png(8, 8) } }),
			{ images },
		);
		expect(work.commentText).toBe("");
		expect(commit).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
	});

	it("写图库失败(磁盘写失败):renderCard 跟着抛,由装配降级成纯文字,出图器没被调", async () => {
		const images: ImageSink = {
			put: async () => {
				throw new Error("磁盘满了");
			},
		};
		const generatePostCard = vi.fn(async () => Buffer.from("card"));
		const image = { generatePostCard } as unknown as ImageRenderer;
		const { work } = await workOf(post({ images: [png(10, 10)] }), { images });
		await expect(work.renderCard(image, {})).rejects.toThrow("磁盘满了");
		expect(generatePostCard).not.toHaveBeenCalled();
	});
});

describe("装配要的那几格", () => {
	it("链接是事件的 url;名字取作者名;没有图集(决策 72);叫法缺省「动态」,给了照用", async () => {
		const { work } = await workOf(post());
		expect(work).toMatchObject({
			link: "https://www.douyin.com/video/p1",
			name: "作者甲",
			isVideo: false,
			postNoun: "动态",
			gallery: [],
		});
		expect((await workOf(post(), { postNoun: "作品" })).work.postNoun).toBe("作品");
		expect((await workOf(post({ video: {} }))).work.isVideo).toBe(true);
	});

	it('AI 的正文 = postText(post, "labeled"):作品正文 +「视频标题：…」;拼不出字就是空串(不点评)', async () => {
		const text = async (p: Reported) => (await workOf(p)).work.commentText;
		expect(await text(post({ text: "今天发新歌", video: { title: "新歌 MV" } }))).toBe(
			"今天发新歌\n视频标题：新歌 MV",
		);
		expect(await text(post({ text: "只有正文" }))).toBe("只有正文");
		expect(await text(post({ video: { title: "只有标题" } }))).toBe("视频标题：只有标题");
		expect(await text(post({ text: "   " }))).toBe("");
	});

	it('取段只此一份:AI 看到的与 postText(translated, "labeled") 逐字相同(话题标签、CRLF 一并算在内)', async () => {
		const { work, translated } = await workOf(
			post({ text: "第一行\r\n去 #海边# 玩", topics: ["海边"], video: { title: "视频" } }),
		);
		expect(work.commentText).toBe(postText(translated, "labeled"));
		expect(work.commentText).toBe("第一行\n去 #海边# 玩\n视频标题：视频");
	});

	it("AI 的图 = 作品图 + 视频封面,前 4 张;单张太大就跳过,让后面的顶上", async () => {
		const small = [1, 2, 3].map((i) => png(8, 8, i));
		const huge = png(8, 8, 9, POST_COMMENT_IMAGE_MAX_BYTES + 1);
		const cover = png(8, 8, 7);
		const { work } = await workOf(
			post({ images: [small[0], huge, small[1], small[2]] as Uint8Array[], video: { cover } }),
		);
		expect(work.commentImages).toEqual([
			...small.map((b) => dataUrl("image/png", b)),
			dataUrl("image/png", cover),
		]);
		const many = await workOf(post({ images: Array.from({ length: 6 }, (_, i) => png(8, 8, i)) }));
		// 张数上限就是装配(deliverWork)用的那一个数,不另抄一份。
		expect(many.work.commentImages).toHaveLength(WORK_COMMENT_IMAGES_MAX);
	});

	it("AI 的图点评真要看时才编,而且只编一次", async () => {
		const { work } = await workOf(post({ images: [png(8, 8, 1)] }));
		expect(work.commentImages).toBe(work.commentImages);
	});
});

describe("真图库写盘失败(环境的事)", () => {
	it("图库的目录建不出来:renderCard 跟着抛、原因带着,出图器没被调", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-post-work-"));
		try {
			// 图库的目录是个普通文件:往里写必挂(ENOTDIR)。
			const blocked = join(dir, "挡路");
			await writeFile(blocked, "x");
			const images = createImageStore({ dir: blocked }).register({
				name: "作品配图",
				listRefs: async () => [],
			});
			const generatePostCard = vi.fn(async () => Buffer.from("card"));
			const image = { generatePostCard } as unknown as ImageRenderer;
			const { work } = await workOf(post({ images: [png(10, 10)] }), { images });

			await expect(work.renderCard(image, {})).rejects.toThrow(/ENOTDIR/);
			expect(generatePostCard).not.toHaveBeenCalled();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
