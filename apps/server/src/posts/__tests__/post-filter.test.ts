/**
 * 单元测试 — `filterPost`:过滤吃平台中立的 `Post`,**一份实现,所有来源同一个**(ADR-0021 决策 43、ADR-0028 决策 1)。
 *
 * 业务正确性核心:用户在高级规则里配的屏蔽 / 白名单决定一条作品推不推。任何一条被改坏 = 用户看到漏推 / 推了不该推的。
 *
 * - 文字:`postText(post, "plain")` 取段 —— 正文、标题(文章标题)、视频标题、被转发的原作品里的字都参与匹配;
 * - 类型开关只看**最外层**:`blockReposts` ← 有 `repost`、`blockArticles` ← 有 `article`、`blockImages` ← 有图集 `images`、
 *   `blockVideos` ← 有 `video`。被转发的原作品里的图集与视频归 `blockReposts` 管,不另外拦;
 * - 对所有来源生效:拓展作品不再豁免类型开关(从前的「抖音几乎全是视频」豁免随 ㉑e 删掉)。
 *
 * 过滤吃的本来就是中立的 `Post`,所以这里的作品一律手工造(`posts/` 的测试不依赖 `bilibili/`):B 站翻出来是什么形状
 * (转发带 `repost`、专栏带 `article`、图文带 `images`、投稿带 `video`)由 `post-from-dynamic.test.ts` 钉,拓展那一腿的
 * 逐开关用例在 `runtime/__tests__/pipeline.test.ts` 的拓展作品过滤接线。
 */

import { DEFAULT_CONTENT_FILTERS, type Logger, type Post } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { filterPost, PostFilterReason, type PostFilterRules } from "../post-filter";
import { postText } from "../post-text";

/** 出厂的过滤(什么都不拦)上盖几格。 */
const rules = (over: Partial<PostFilterRules> = {}): PostFilterRules => ({
	...DEFAULT_CONTENT_FILTERS,
	...over,
});

/** 一条什么都没有的中立作品;各用例往上加格。 */
const neutral = (over: Partial<Post> = {}): Post => ({
	creator: { name: "作者" },
	publishedAt: "2026-10-05T00:00:00.000Z",
	text: "",
	...over,
});

const IMAGE = { ref: `${"a".repeat(63)}1.png` };

/**
 * 「B 站翻出来的形状」(照 `postFromDynamic` 的输出手工造):投稿带 `video`、转发带 `repost`、专栏带 `article`、
 * 图文带 `images`。字都取自原来那批 B 站夹具里的原话。
 */
const biliAv = neutral({
	text: "一键三连",
	label: "投稿了视频",
	video: { cover: IMAGE, title: "MC恐怖地图 毒药", description: "" },
});
const biliForward = neutral({
	text: "这期真的建议看完",
	repost: neutral({
		creator: { name: "原作者" },
		text: "原文",
		video: { cover: IMAGE, title: "MC恐怖地图 毒药", description: "" },
	}),
});
const biliArticle = neutral({
	label: "投稿了专栏",
	text: "专栏摘要",
	article: { title: "年度总结", images: [IMAGE] },
});
const biliDraw = neutral({ text: "图文", images: [IMAGE, IMAGE] });

/** 「拓展翻出来的形状」:图集是带引用的 `PostImage`,视频是 `video`,没有 repost / article(拓展的上报里没有这两样)。 */
const extensionImages = neutral({ text: "旅行第 1 天", images: [IMAGE, IMAGE, IMAGE] });
const extensionVideo = neutral({
	text: "看视频",
	label: "投稿了视频",
	video: { cover: IMAGE, title: "一期视频", description: "" },
});

// ── 出厂放行 ──────────────────────────────────────────────────────────────────

describe("出厂的过滤什么都不拦", () => {
	it("所有规则为空 / 关着:任何一条作品都放行", () => {
		for (const post of [
			neutral({ text: "含禁词 ABC" }),
			biliAv,
			biliForward,
			biliArticle,
			biliDraw,
			extensionImages,
			extensionVideo,
		]) {
			expect(filterPost(post, rules())).toEqual({ blocked: false });
		}
	});
});

// ── 类型开关:每个开关一条 B 站、一条拓展 ─────────────────────────────────────────

describe("类型开关 —— 对所有来源生效,只看最外层", () => {
	describe("blockReposts ← 有 repost", () => {
		it("B 站:转发动态翻出来的 Post 被拦,原因是转发", () => {
			expect(filterPost(biliForward, rules({ blockReposts: true }))).toEqual({
				blocked: true,
				reason: PostFilterReason.BlockedReposts,
			});
		});

		it("拓展:作品里没有 repost(上报里没有这一格),开着也不拦", () => {
			expect(filterPost(extensionImages, rules({ blockReposts: true }))).toEqual({
				blocked: false,
			});
			expect(filterPost(extensionVideo, rules({ blockReposts: true }))).toEqual({ blocked: false });
		});

		it("来源无关:谁的作品带 repost,开关就拦谁的", () => {
			const post = neutral({ text: "转发语", repost: neutral({ text: "原文" }) });
			expect(filterPost(post, rules({ blockReposts: true })).reason).toBe(
				PostFilterReason.BlockedReposts,
			);
			expect(filterPost(post, rules())).toEqual({ blocked: false });
		});
	});

	describe("blockArticles ← 有 article", () => {
		it("B 站:专栏翻出来的 Post 被拦,原因是专栏", () => {
			expect(filterPost(biliArticle, rules({ blockArticles: true }))).toEqual({
				blocked: true,
				reason: PostFilterReason.BlockedArticles,
			});
		});

		it("拓展:作品里没有 article,开着也不拦", () => {
			expect(filterPost(extensionImages, rules({ blockArticles: true }))).toEqual({
				blocked: false,
			});
		});

		it("只有 title 的带标题图文不算文章", () => {
			const post = neutral({ title: "带标题的图文", text: "正文", images: [IMAGE] });
			expect(filterPost(post, rules({ blockArticles: true }))).toEqual({ blocked: false });
		});
	});

	describe("blockImages ← 有图集 images", () => {
		it("B 站:图文动态翻出来的 Post 被拦,原因是图集", () => {
			expect(filterPost(biliDraw, rules({ blockImages: true }))).toEqual({
				blocked: true,
				reason: PostFilterReason.BlockedImages,
			});
		});

		it("拓展:带配图的作品被拦(从前拓展豁免类型开关,这是主人拍板的行为变化)", () => {
			expect(filterPost(extensionImages, rules({ blockImages: true }))).toEqual({
				blocked: true,
				reason: PostFilterReason.BlockedImages,
			});
		});

		it("没有图集(没有 images,或是空数组)不拦;文章配图不是图集", () => {
			expect(filterPost(neutral({ text: "纯文字" }), rules({ blockImages: true }))).toEqual({
				blocked: false,
			});
			expect(filterPost(neutral({ images: [] }), rules({ blockImages: true }))).toEqual({
				blocked: false,
			});
			expect(
				filterPost(
					neutral({ article: { title: "文", images: [IMAGE] } }),
					rules({ blockImages: true }),
				),
			).toEqual({ blocked: false });
		});
	});

	describe("blockVideos ← 有 video", () => {
		it("B 站:视频投稿翻出来的 Post 被拦,原因是视频", () => {
			expect(filterPost(biliAv, rules({ blockVideos: true }))).toEqual({
				blocked: true,
				reason: PostFilterReason.BlockedVideos,
			});
		});

		it("拓展:带视频的作品被拦(抖音号全局开着「屏蔽视频」就是这个效果,是主人拍板的)", () => {
			expect(filterPost(extensionVideo, rules({ blockVideos: true }))).toEqual({
				blocked: true,
				reason: PostFilterReason.BlockedVideos,
			});
		});

		it("附加块里引用的视频卡不是作品本身的视频,不拦", () => {
			const post = neutral({
				text: "推荐一个视频",
				attachment: { kind: "video", cover: IMAGE, title: "别人的视频" },
			});
			expect(filterPost(post, rules({ blockVideos: true }))).toEqual({ blocked: false });
		});
	});

	it("四个开关互不串扰:每个只管自己那一格,别的作品不受牵连", () => {
		const cases: [keyof PostFilterRules, Post][] = [
			["blockReposts", biliForward],
			["blockArticles", biliArticle],
			["blockImages", biliDraw],
			["blockVideos", biliAv],
		];
		for (const [key, owner] of cases) {
			for (const [, other] of cases.filter(([k]) => k !== key)) {
				// 转发动态里带着视频(它的原作品),只开 blockVideos 时也不该被拦 —— 见下面「只看最外层」。
				expect(filterPost(other, rules({ [key]: true })).blocked, `${key}`).toBe(false);
			}
			expect(filterPost(owner, rules({ [key]: true })).blocked, `${key}`).toBe(true);
		}
	});

	it("同一条作品命中几个开关:按 转发 → 专栏 → 图集 → 视频 的次序报第一个", () => {
		const post = neutral({
			repost: neutral(),
			article: { title: "文" },
			images: [IMAGE],
			video: { cover: IMAGE, title: "v", description: "" },
		});
		const all = rules({
			blockReposts: true,
			blockArticles: true,
			blockImages: true,
			blockVideos: true,
		});
		expect(filterPost(post, all).reason).toBe(PostFilterReason.BlockedReposts);
		const { repost: _repost, ...noRepost } = post;
		expect(filterPost(noRepost, all).reason).toBe(PostFilterReason.BlockedArticles);
		const { article: _article, ...noArticle } = noRepost;
		expect(filterPost(noArticle, all).reason).toBe(PostFilterReason.BlockedImages);
		const { images: _images, ...onlyVideo } = noArticle;
		expect(filterPost(onlyVideo, all).reason).toBe(PostFilterReason.BlockedVideos);
	});

	it("类型开关排在文字之前:同时命中类型与关键词,报的是类型", () => {
		const post = neutral({ text: "含禁词", video: { cover: IMAGE, title: "v", description: "" } });
		expect(filterPost(post, rules({ blockVideos: true, blockKeywords: ["禁词"] })).reason).toBe(
			PostFilterReason.BlockedVideos,
		);
	});
});

describe("类型开关只看最外层 —— 被转发的原作品里的图集与视频归「屏蔽转发」管", () => {
	/** 转发了一条带图集的图文 / 带视频的投稿(外层只有转发语)。 */
	const forwardOf = (origin: Post): Post => neutral({ text: "转发语", repost: origin });
	const drawOrigin = neutral({ text: "原图文", images: [IMAGE, IMAGE] });
	const avOrigin = neutral({
		text: "原投稿",
		video: { cover: IMAGE, title: "原视频", description: "" },
	});

	it("夹具本身:转发的外层没有图集也没有视频,原作品里有", () => {
		const withImages = forwardOf(drawOrigin);
		expect(withImages.images).toBeUndefined();
		expect(withImages.repost?.images?.length).toBeGreaterThan(0);
		const withVideo = forwardOf(avOrigin);
		expect(withVideo.video).toBeUndefined();
		expect(withVideo.repost?.video).toBeDefined();
	});

	it("转发了一条带图集的作品:只开 blockImages 不拦,开 blockReposts 才拦", () => {
		const post = forwardOf(drawOrigin);
		expect(filterPost(post, rules({ blockImages: true }))).toEqual({ blocked: false });
		expect(filterPost(post, rules({ blockReposts: true })).reason).toBe(
			PostFilterReason.BlockedReposts,
		);
	});

	it("转发了一条带视频的作品:只开 blockVideos 不拦,开 blockReposts 才拦", () => {
		const post = forwardOf(avOrigin);
		expect(filterPost(post, rules({ blockVideos: true }))).toEqual({ blocked: false });
		expect(filterPost(post, rules({ blockReposts: true })).reason).toBe(
			PostFilterReason.BlockedReposts,
		);
	});

	it("原作品是专栏也一样:只开 blockArticles 不拦", () => {
		const article = neutral({ text: "原专栏", article: { title: "原专栏标题" } });
		expect(filterPost(forwardOf(article), rules({ blockArticles: true }))).toEqual({
			blocked: false,
		});
	});

	it("手造的中立作品同理(来源无关)", () => {
		const post = neutral({
			text: "转发语",
			repost: neutral({
				images: [IMAGE],
				video: { cover: IMAGE, title: "v", description: "" },
				article: { title: "文" },
			}),
		});
		expect(
			filterPost(post, rules({ blockImages: true, blockVideos: true, blockArticles: true })),
		).toEqual({
			blocked: false,
		});
		expect(filterPost(post, rules({ blockReposts: true })).blocked).toBe(true);
	});
});

// ── 文字:取段 ────────────────────────────────────────────────────────────────

describe('文字走 postText(post, "plain"):每一段都参与匹配', () => {
	/** 禁词 / 放行词出现在作品的哪一段。 */
	const placements: [string, (word: string) => Post][] = [
		["正文", (word) => neutral({ text: `前面 ${word} 后面` })],
		["标题(带标题的图文)", (word) => neutral({ text: "无关", title: `标题 ${word}` })],
		["文章标题", (word) => neutral({ text: "无关", article: { title: `文章 ${word}` } })],
		[
			"视频标题",
			(word) =>
				neutral({
					text: "无关",
					video: { cover: IMAGE, title: `视频 ${word}`, description: "" },
				}),
		],
		[
			"被转发的原作品的正文",
			(word) => neutral({ text: "转发语", repost: neutral({ text: `原文 ${word}` }) }),
		],
		[
			"被转发的原作品的标题与视频标题",
			(word) =>
				neutral({
					text: "转发语",
					repost: neutral({
						text: "原文",
						title: "原标题",
						video: { cover: IMAGE, title: `原视频 ${word}`, description: "" },
					}),
				}),
		],
	];

	describe.each(placements)("%s", (_name, build) => {
		it("blockKeywords 命中 → 拦,原因是关键词", () => {
			expect(filterPost(build("禁词"), rules({ blockKeywords: ["禁词"] }))).toEqual({
				blocked: true,
				reason: PostFilterReason.BlockedKeyword,
			});
			expect(filterPost(build("正常"), rules({ blockKeywords: ["禁词"] }))).toEqual({
				blocked: false,
			});
		});

		it("blockRegex 命中 → 拦,原因是关键词", () => {
			expect(filterPost(build("第 12345 号"), rules({ blockRegex: ["\\d{5}"] }))).toEqual({
				blocked: true,
				reason: PostFilterReason.BlockedKeyword,
			});
			expect(filterPost(build("第 12 号"), rules({ blockRegex: ["\\d{5}"] }))).toEqual({
				blocked: false,
			});
		});

		it("allowKeywords:命中放行,不命中拦(原因是不在白名单)", () => {
			expect(filterPost(build("放行词"), rules({ allowKeywords: ["放行词"] }))).toEqual({
				blocked: false,
			});
			expect(filterPost(build("别的"), rules({ allowKeywords: ["放行词"] }))).toEqual({
				blocked: true,
				reason: PostFilterReason.AllowlistUnmatched,
			});
		});

		it("allowRegex:命中放行,不命中拦", () => {
			expect(filterPost(build("上新啦"), rules({ allowRegex: ["上新"] }))).toEqual({
				blocked: false,
			});
			expect(filterPost(build("别的"), rules({ allowRegex: ["上新"] }))).toEqual({
				blocked: true,
				reason: PostFilterReason.AllowlistUnmatched,
			});
		});
	});

	it("B 站形状的 Post(投稿 / 转发 / 专栏):正文、视频标题、转发的原作品里的字都找得到", () => {
		// 夹具里的原话:AV 的视频标题「MC恐怖地图 毒药」,转发语「这期真的建议看完」。
		expect(filterPost(biliAv, rules({ blockKeywords: ["MC恐怖地图"] })).blocked).toBe(true);
		expect(filterPost(biliAv, rules({ blockKeywords: ["一键三连"] })).blocked).toBe(true);
		const forward = biliForward;
		expect(filterPost(forward, rules({ blockKeywords: ["这期真的建议看完"] })).blocked).toBe(true);
		// 原动态(AV)的视频标题 —— 外层转发自己没有这些字。
		expect(forward.text).not.toContain("毒药");
		expect(filterPost(forward, rules({ blockKeywords: ["毒药"] })).blocked).toBe(true);
		// 专栏标题。
		expect(filterPost(biliArticle, rules({ blockKeywords: ["年度总结"] })).blocked).toBe(true);
	});

	it("取的就是 postText 的 plain 拼法:规则看到的与它逐字相同(换一种取段就会漂)", () => {
		const post = neutral({
			text: "正文",
			title: "标题",
			video: { cover: IMAGE, title: "视频标题", description: "" },
			repost: neutral({ text: "原文" }),
		});
		const seen = postText(post, "plain");
		expect(seen).toBe("正文\n标题\n视频标题\n原文");
		// 跨段的正则能连着匹配,证明交给规则的是同一份拼好的整段。
		expect(filterPost(post, rules({ blockRegex: ["正文\\n标题\\n视频标题\\n原文"] })).blocked).toBe(
			true,
		);
	});

	it("不在 postText 范围里的字不参与匹配(附加块文字、BN 自己说的提示、描述)", () => {
		const post = neutral({
			text: "干净",
			notice: "含禁词的提示",
			attachment: { kind: "card", title: "含禁词的预约", lines: [{ text: "含禁词" }] },
			video: { cover: IMAGE, title: "干净", description: "简介里有禁词" },
		});
		expect(filterPost(post, rules({ blockKeywords: ["禁词"] }))).toEqual({ blocked: false });
	});
});

// ── 规则语义 ──────────────────────────────────────────────────────────────────

describe("屏蔽 / 白名单的规则语义", () => {
	it("blockKeywords 里的空串不算规则(不会命中一切)", () => {
		expect(filterPost(neutral({ text: "随便" }), rules({ blockKeywords: [""] }))).toEqual({
			blocked: false,
		});
	});

	it("白名单没有任何规则 → 放行(空规则不拦);只写了一种也算有规则", () => {
		expect(filterPost(neutral({ text: "任何文本" }), rules())).toEqual({ blocked: false });
		expect(filterPost(neutral({ text: "x" }), rules({ allowKeywords: ["y"] })).blocked).toBe(true);
		expect(filterPost(neutral({ text: "x" }), rules({ allowRegex: ["y"] })).blocked).toBe(true);
	});

	it("白名单关键词与正则任一命中即放行", () => {
		const both = rules({ allowKeywords: ["新歌"], allowRegex: ["^上新"] });
		expect(filterPost(neutral({ text: "上新啦" }), both).blocked).toBe(false);
		expect(filterPost(neutral({ text: "今天新歌" }), both).blocked).toBe(false);
		expect(filterPost(neutral({ text: "日常" }), both).blocked).toBe(true);
	});

	it("黑白名单组合:黑名单优先(命中黑名单即阻断,不考虑白名单)", () => {
		const result = filterPost(
			neutral({ text: "包含禁词也包含放行词" }),
			rules({ blockKeywords: ["禁词"], allowKeywords: ["放行词"] }),
		);
		expect(result).toEqual({ blocked: true, reason: PostFilterReason.BlockedKeyword });
	});

	it("屏蔽正则有好几条时每条各自判:一条非法不连累另一条", () => {
		const text = neutral({ text: "编号 12345" });
		expect(filterPost(text, rules({ blockRegex: ["[invalid(", "\\d{5}"] })).blocked).toBe(true);
		expect(filterPost(text, rules({ blockRegex: ["\\d{5}", "[invalid("] })).blocked).toBe(true);
		expect(filterPost(text, rules({ blockRegex: ["[invalid(", "也不对("] })).blocked).toBe(false);
	});

	it("白名单正则同样每条各自判", () => {
		expect(
			filterPost(neutral({ text: "上新" }), rules({ allowRegex: ["[invalid(", "^上新"] })).blocked,
		).toBe(false);
	});

	it("无效正则:不抛错,只跳过该规则;logger 收到一句 warn", () => {
		const warn = vi.fn();
		const logger = { warn } as unknown as Logger;
		const result = filterPost(
			neutral({ text: "正常文本" }),
			rules({ blockRegex: ["[invalid("] }),
			logger,
		);
		expect(result.blocked).toBe(false);
		expect(warn).toHaveBeenCalledWith("作品过滤正则被拒绝执行", {
			pattern: "[invalid(",
			message: expect.stringContaining("正则非法:"),
		});
	});

	// 日志由宿主的 posts 标签归属，正文不再重复模块名。
	it("被拒的正则使用中立说明，诊断保留原模式", () => {
		const warn = vi.fn();
		const logger = { warn } as unknown as Logger;
		// 灾难性回溯被拒一条;写不成正则的(过不了统一闸门的编译校验)也是同一句「拒绝执行」。
		filterPost(neutral({ text: "a" }), rules({ blockRegex: ["(a+)+$"] }), logger);
		filterPost(neutral({ text: "a" }), rules({ blockRegex: ["[invalid("] }), logger);
		const lines = warn.mock.calls.map((call) => String(call[0]));
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(line).toBe("作品过滤正则被拒绝执行");
		expect(warn.mock.calls.map((call) => call[1]?.pattern)).toEqual(["(a+)+$", "[invalid("]);
	});
});

describe("ReDoS 加固(正则走 internal 的统一闸门 + 只对前 1 万字求值)", () => {
	it("嵌套量词灾难性正则被拒(当无效正则处理,不阻断、瞬时返回)", () => {
		const evil = `${"a".repeat(40)}X`;
		const t0 = Date.now();
		const result = filterPost(neutral({ text: evil }), rules({ blockRegex: ["(a+)+$"] }));
		expect(result.blocked).toBe(false);
		expect(Date.now() - t0).toBeLessThan(1000);
	});

	it("白名单侧灾难性正则被拒 → 该规则视为无匹配(AllowlistUnmatched)", () => {
		const evil = `${"a".repeat(40)}X`;
		const result = filterPost(neutral({ text: evil }), rules({ allowRegex: ["(a+)+$"] }));
		expect(result).toEqual({ blocked: true, reason: PostFilterReason.AllowlistUnmatched });
	});

	it("超长正则(>200)被拒", () => {
		expect(
			filterPost(neutral({ text: "x" }), rules({ blockRegex: ["a".repeat(201)] })).blocked,
		).toBe(false);
	});

	it("正常正则仍照常工作(回归)", () => {
		const hit = filterPost(
			neutral({ text: "看我的 https://b23.tv/abc 链接" }),
			rules({ blockRegex: ["https?://\\S+"] }),
		);
		expect(hit).toEqual({ blocked: true, reason: PostFilterReason.BlockedKeyword });
		expect(
			filterPost(neutral({ text: "纯文字无链接" }), rules({ blockRegex: ["https?://\\S+"] }))
				.blocked,
		).toBe(false);
	});

	it("正则只对前 1 万字求值:禁词在一万字之后不命中", () => {
		const far = neutral({ text: `${"空".repeat(10_000)}禁词` });
		expect(filterPost(far, rules({ blockRegex: ["禁词"] })).blocked).toBe(false);
		// 关键词是 includes,不受这条限制。
		expect(filterPost(far, rules({ blockKeywords: ["禁词"] })).blocked).toBe(true);
	});
});
