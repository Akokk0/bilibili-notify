/**
 * 拓展上报的作品 → 平台中立的 `Post`(`postFromReport`,ADR-0021 决策 22 下 2026-10-05 的 🔗,㉑d)。
 *
 * 钉的是「拓展交的那张表」翻过去之后每一格从哪来:作者与头像(事件字节存进图库 / 资料里的引用)、话题
 * (第一个进标签、正文里照报的名字上色)、只存前 9 张图且宽高 BN 自己读、图库不收的图没有地址、视频与互动数、
 * 时间。图用**真的图库**存(临时目录),引用是真的内容哈希,字节能从图库读回来。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GALLERY_MAX_IMAGES } from "@bilibili-notify/image";
import { normalizePost, type SubscriptionReportValue } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { gif, png } from "../../__tests__/support/report-images.js";
import {
	createImageStore,
	IMAGE_MAX_BYTES,
	type ImageStore,
	type ImageWriter,
} from "../../images/image-store.js";
import { deferImageWrites } from "../../images/image-writes.js";
import { plainTextSegments, postFromReport } from "../post-from-report.js";

type Reported = SubscriptionReportValue<"post">;

/** 本机时区的 2026-09-24 12:00:05;ISO 串由同一个时刻算,与时区无关。 */
const PUBLISHED = new Date(2026, 8, 24, 12, 0, 5).getTime();

let dir: string;
let store: ImageStore;
let writer: ImageWriter;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-post-from-report-"));
	store = createImageStore({ dir: join(dir, "images") });
	writer = store.register({ name: "作品配图", listRefs: async () => [] });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function report(over: Partial<Reported> = {}): Reported {
	return { id: "p1", url: "https://www.douyin.com/video/p1", publishedAt: PUBLISHED, ...over };
}

const translate = (over: Partial<Reported> = {}) =>
	postFromReport(report(over), { authorName: "作者甲", images: writer });

const refOf = async (bytes: Uint8Array) => {
	const stored = await writer.put(bytes);
	if (!stored.ok) throw new Error(`夹具图存不进图库:${stored.message}`);
	return stored.ref;
};

describe("作者、时间、正文", () => {
	it("只有正文:作者名照给的,时间毫秒 → ISO,没有话题 / 富文本 / 配图 / 视频 / 互动数", async () => {
		const post = await translate({ text: "第一行\n第二行" });
		expect(post).toEqual({
			creator: { name: "作者甲" },
			publishedAt: new Date(PUBLISHED).toISOString(),
			text: "第一行\n第二行",
		});
	});

	it("\\r\\n 与 \\r 统一成 \\n;一个字都没有(空串 / 只有空白 / 没给)的正文是空串", async () => {
		expect((await translate({ text: "甲\r\n乙\r丙" })).text).toBe("甲\n乙\n丙");
		for (const text of ["", " \n\t ", undefined]) {
			const post = await translate({ text });
			expect(post.text).toBe("");
			expect(post.richText).toBeUndefined();
		}
	});

	it("不是有效时刻的时间落在纪元,不把整张卡弄抛", async () => {
		expect((await translate({ publishedAt: Number.NaN })).publishedAt).toBe(
			new Date(0).toISOString(),
		);
	});

	it("译出来的 Post 过得了 normalizePost(富文本片段的字拼起来就是正文),再过一遍不变", async () => {
		const post = await translate({
			text: "去 #海边# 玩,顺便 #旅行",
			topics: ["海边", "旅行"],
		});
		expect(post.richText).toBeDefined();
		expect(normalizePost(post)).toEqual(post);
	});
});

describe("话题:第一个进标签,正文里照报的名字上色", () => {
	it("topics[0] → topic;其余不进标签", async () => {
		const post = await translate({ text: "走了一天 #城市散步", topics: ["城市散步", "vlog"] });
		expect(post.topic).toBe("城市散步");
	});

	it("没报话题就没有标签,正文里长得像话题的 # 照字面(不带富文本)", async () => {
		for (const topics of [undefined, []]) {
			const post = await translate({ text: "只有字 #看着像话题", topics });
			expect(post.topic).toBeUndefined();
			expect(post.richText).toBeUndefined();
		}
	});

	it("报了话题、正文里一个都没找到:不带富文本(整段 text 片段与 text 没有区别)", async () => {
		const post = await translate({ text: "今天走了两万步 #城市散步", topics: ["vlog"] });
		expect(post.topic).toBe("vlog");
		expect(post.richText).toBeUndefined();
	});

	it("找到了:话题是 topic 片段(带名字),其余是 text 片段", async () => {
		const post = await translate({ text: "去 #海边# 玩", topics: ["海边"] });
		expect(post.richText).toEqual([
			{ kind: "text", text: "去 " },
			{ kind: "topic", text: "#海边#", name: "海边" },
			{ kind: "text", text: " 玩" },
		]);
	});
});

describe("plainTextSegments — 照拓展报的话题名切正文(从前 buildPlainText 的话题规矩,原样搬过来)", () => {
	const topic = (text: string, name = text.replace(/#/g, "")) => ({ kind: "topic", text, name });
	const text = (t: string) => ({ kind: "text", text: t });

	it("#名字# 与 #名字 都上色,两边的字照旧", () => {
		expect(plainTextSegments("去 #海边# 玩,顺便 #旅行", ["海边", "旅行"])).toEqual([
			text("去 "),
			topic("#海边#", "海边"),
			text(" 玩,顺便 "),
			topic("#旅行", "旅行"),
		]);
	});

	it("名字有包含关系时长的先匹配,与报的次序无关", () => {
		expect(plainTextSegments("#旅行日记 和 #旅行", ["旅行", "旅行日记"])).toEqual([
			topic("#旅行日记", "旅行日记"),
			text(" 和 "),
			topic("#旅行", "旅行"),
		]);
	});

	it("#名字# 优先于 #名字:收尾的 # 算进话题,不留给后面", () => {
		expect(plainTextSegments("#旅行#日记", ["旅行"])).toEqual([
			topic("#旅行#", "旅行"),
			text("日记"),
		]);
	});

	it("#名字# 收尾的 # 正是下一个话题的开头:让给下一个,两个都上色", () => {
		expect(plainTextSegments("#旅行#美食", ["旅行", "美食"])).toEqual([
			topic("#旅行", "旅行"),
			topic("#美食", "美食"),
		]);
	});

	it("收尾的 # 后面那个名字其实对不上(被字接着):收尾的 # 照旧算进前一个话题", () => {
		expect(plainTextSegments("#旅行#美食家", ["旅行", "美食"])).toEqual([
			topic("#旅行#", "旅行"),
			text("美食家"),
		]);
	});

	it("#名字 后面紧跟字母 / 数字就不是这个话题 —— 「#cat」不从「#category」里抠出来", () => {
		const none = [
			["#category", "cat"],
			["#cat123", "cat"],
			["#旅行今天", "旅行"],
			// 扩展区的汉字占两个 UTF-16 单元,也得认成字。
			["#cat\u{20000}", "cat"],
		] as const;
		for (const [t, name] of none) {
			expect(plainTextSegments(t, [name]), t).toEqual([text(t)]);
		}
		expect(plainTextSegments("#cat is cute", ["cat"])[0]).toEqual(topic("#cat", "cat"));
		expect(plainTextSegments("#旅行，今天", ["旅行"])).toEqual([
			topic("#旅行", "旅行"),
			text("，今天"),
		]);
		expect(plainTextSegments("#旅行\u{1F600}", ["旅行"])[0]).toEqual(topic("#旅行", "旅行"));
		// #名字# 自己带着边界,后面跟什么字都不影响。
		expect(plainTextSegments("#cat#egory", ["cat"])).toEqual([
			topic("#cat#", "cat"),
			text("egory"),
		]);
	});

	it("名字在正文里找不到:不切、不出错,与没给话题时一模一样", () => {
		const t = "今天走了两万步 #城市散步";
		expect(plainTextSegments(t, ["vlog"])).toEqual([text(t)]);
		expect(plainTextSegments(t, [])).toEqual([text(t)]);
	});

	it("不在名单里的 # 一律不动 —— 「C#」「#1」不是话题,BN 不按 # 猜", () => {
		expect(plainTextSegments("学 C# 的第 #1 课 #编程", ["编程"])).toEqual([
			text("学 C# 的第 #1 课 "),
			topic("#编程", "编程"),
		]);
	});

	it("标签原样当文字,不转义也不吞(转义归出图器);换行照旧落在原处", () => {
		expect(plainTextSegments("<b>粗</b> #<i>#", ["<i>"])).toEqual([
			text("<b>粗</b> "),
			topic("#<i>#", "<i>"),
		]);
		expect(plainTextSegments("第一行 #话题\n第二行 #话题#", ["话题"])).toEqual([
			text("第一行 "),
			topic("#话题", "话题"),
			text("\n第二行 "),
			topic("#话题#", "话题"),
		]);
	});

	it("片段的字拼起来恒等于传进来的正文", () => {
		const cases: [string, string[]][] = [
			["#旅行#美食 #cat #category C# #1", ["旅行", "美食", "cat"]],
			["", ["a"]],
			["没有井号", ["a"]],
			["##a## #a#a", ["a"]],
		];
		for (const [t, names] of cases) {
			expect(
				plainTextSegments(t, names)
					.map((s) => s.text)
					.join(""),
				t,
			).toBe(t);
		}
	});
});

describe("配图:前 9 张存进图库,宽高 BN 读文件头,图库不收的没有地址", () => {
	it("前 9 张各存一次、带图库引用与宽高;gif 标动图;第 10 张起不存、只占着张数", async () => {
		const bytes = [
			png(100, 300, 0),
			gif(40, 30),
			...Array.from({ length: 10 }, (_, i) => png(64, 64, i + 1)),
		];
		const put = vi.spyOn(writer, "put");
		const post = await translate({ images: bytes });

		expect(post.images).toHaveLength(12);
		expect(put).toHaveBeenCalledTimes(GALLERY_MAX_IMAGES);
		const first = post.images?.[0];
		expect(first).toEqual({
			ref: await refOf(bytes[0] as Uint8Array),
			width: 100,
			height: 300,
			isAnimated: false,
		});
		expect(post.images?.[1]).toMatchObject({ width: 40, height: 30, isAnimated: true });
		expect(post.images?.[8]?.ref).toBe(await refOf(bytes[8] as Uint8Array));
		// 第 10 张起什么地址都没有(也不带宽高):图廊折进 `+N`、不画。
		for (const rest of post.images?.slice(GALLERY_MAX_IMAGES) ?? []) expect(rest).toEqual({});
	});

	it("存进图库的字节与报上来的逐字节相同", async () => {
		const original = png(10, 10, 3);
		const post = await translate({ images: [original] });
		const read = await store.read(post.images?.[0]?.ref as string);
		expect(read && Buffer.from(read.bytes).equals(Buffer.from(original))).toBe(true);
	});

	it("宽高读不出来就不带(出卡照样出,只是不判长图);图本身照样存", async () => {
		const broken = png(10, 10).slice(0, 20);
		const post = await translate({ images: [broken] });
		expect(post.images?.[0]).toEqual({ ref: await refOf(broken), isAnimated: false });
	});

	it("图库不收的图(格式不认、超过上限)没有 ref 也没有 url:出图器画占位,与从前同一个可见行为", async () => {
		const notImage = new Uint8Array([1, 2, 3, 4]);
		const huge = png(10, 10, 9, IMAGE_MAX_BYTES + 1);
		const post = await translate({ images: [png(10, 10, 1), notImage, huge] });
		expect(post.images?.[0]?.ref).toBeDefined();
		expect(post.images?.[1]).toEqual({ isAnimated: false });
		// 超限的 png 仍是 png:宽高、动图标记是字节自己的事,照带。
		expect(post.images?.[2]).toEqual({ width: 10, height: 10, isAnimated: false });
		for (const image of post.images ?? []) expect(image).not.toHaveProperty("url");
	});

	it("磁盘写失败是抛错(这一次出卡失败,装配降级成纯文字),不是悄悄少一张图", async () => {
		const failing: Pick<ImageWriter, "put"> = {
			put: async () => {
				throw new Error("磁盘满了");
			},
		};
		await expect(
			postFromReport(report({ images: [png(10, 10)] }), { authorName: "甲", images: failing }),
		).rejects.toThrow("磁盘满了");
	});

	it("没有图就没有 images", async () => {
		expect((await translate({ text: "只有字" })).images).toBeUndefined();
		expect((await translate({ images: [] })).images).toBeUndefined();
	});
});

describe("作者头像:事件带的字节存进图库,否则没有(外层头像由核心出卡时按订阅资料补)", () => {
	it("事件带了图库收的头像:存进图库,Creator.avatar 是它的引用", async () => {
		const avatar = png(8, 8, 77);
		const post = await translate({ author: { avatar } });
		expect(post.creator.avatar).toBe(await refOf(avatar));
	});

	it("事件带的头像图库不收(不是图 / 超限):没有头像格,不去碰订阅资料", async () => {
		const post = await translate({ author: { avatar: new Uint8Array([9, 9, 9]) } });
		expect(post.creator).toEqual({ name: "作者甲" });
	});

	it("事件没带头像:Creator 没有头像格(出图器的头像块收起),也不存任何头像", async () => {
		const put = vi.spyOn(writer, "put");
		const post = await translate({ author: { name: "事件里的名字" } });
		expect(post.creator).toEqual({ name: "作者甲" });
		expect(put).not.toHaveBeenCalled();
	});
});

describe("视频:video + 标签「投稿了视频」", () => {
	it("封面存进图库,时长 / 播放数是数字(排版归出图器),简介原样", async () => {
		const cover = png(16, 9, 5);
		const post = await translate({
			video: { cover, title: "一期视频", duration: 3725.6, description: "简介", plays: 12_345 },
		});
		expect(post.label).toBe("投稿了视频");
		expect(post.video).toEqual({
			cover: { ref: await refOf(cover), width: 16, height: 9, isAnimated: false },
			title: "一期视频",
			description: "简介",
			durationSec: 3725.6,
			views: 12_345,
		});
	});

	it("没报的格空着:没有封面是空的 PostImage(出图器画占位),没有标题 / 简介是空串,没有时长 / 播放数不带", async () => {
		const post = await translate({ video: { title: "只有标题" } });
		expect(post.video).toEqual({ cover: {}, title: "只有标题", description: "" });
		expect((await translate({ video: {} })).video).toEqual({
			cover: {},
			title: "",
			description: "",
		});
	});

	it("没有视频就没有标签,也没有 video", async () => {
		const post = await translate({ text: "x" });
		expect(post.video).toBeUndefined();
		expect(post.label).toBeUndefined();
	});
});

describe("互动数:交数字,排版归出图器", () => {
	it("报了的几项照搬成数字;没报的那一项不带", async () => {
		expect((await translate({ stats: { likes: 12_345, comments: 45 } })).stats).toEqual({
			likes: 12_345,
			comments: 45,
		});
		expect((await translate({ stats: { shares: 3 } })).stats).toEqual({ shares: 3 });
	});

	it("整格没报或一项都没有:没有 stats(那一排收起)", async () => {
		expect((await translate()).stats).toBeUndefined();
		expect((await translate({ stats: {} })).stats).toBeUndefined();
	});
});

describe("deferImageWrites 配合 postFromReport", () => {
	it("配合 postFromReport:翻出来的 Post 引用齐全,commit 之前图库空、之后全在", async () => {
		const [shot, avatar] = [png(10, 10, 1), png(8, 8, 2)];
		const deferred = deferImageWrites(writer);
		const post = await postFromReport(report({ images: [shot], author: { avatar } }), {
			authorName: "作者甲",
			images: deferred.sink,
		});
		const refs = [post.images?.[0]?.ref, post.creator.avatar] as string[];
		expect(refs.every((ref) => typeof ref === "string")).toBe(true);
		for (const ref of refs) expect(await store.read(ref)).toBeUndefined();
		await deferred.commit();
		for (const ref of refs) expect(await store.read(ref)).toBeDefined();
	});
});

describe("postFromReport — 存图口回的不是 invalid", () => {
	/** 今天生产里拿到的口是 `deferImageWrites` 的 `sink`,只回 ok / invalid;真图库直接传进来时盘满回的是 unavailable。 */
	const unavailable: Pick<ImageWriter, "put"> = {
		put: async () => ({ ok: false, code: "unavailable", message: "图库写盘失败:盘满了" }),
	};

	it("配图存不下来(unavailable):抛、原因带着,不是悄悄少一张图", async () => {
		await expect(
			postFromReport(report({ images: [png(10, 10)] }), { authorName: "甲", images: unavailable }),
		).rejects.toThrow("盘满了");
	});

	it("事件带的头像存不下来(unavailable):抛,不是悄悄少一个头像", async () => {
		await expect(
			postFromReport(report({ author: { avatar: png(8, 8) } }), {
				authorName: "甲",
				images: unavailable,
			}),
		).rejects.toThrow("盘满了");
	});
});
