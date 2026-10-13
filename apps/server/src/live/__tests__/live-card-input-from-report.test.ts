/**
 * **拓展上报的直播状态 → 中立的直播卡输入**(`liveCardInputFromReport`,ADR-0021 决策 22 / 24 下 2026-10-05 的 🔗,㉒c)。
 *
 * 拓展交的是字节:封面与事件带来的作者头像经图库的存图口翻成引用(图库不收的图当没有),订阅资料里的头像本来就是
 * 图库引用;开播时刻是毫秒、卡输入里是 ISO;人数只收精确数,没报就没有这个键。
 * 照 `postFromReport` 的样子(`posts/__tests__/post-from-report.test.ts`)。
 *
 * 从前这里的前身是 `extensionCardAuthor`(把头像字节转 data URL,哪儿都没有就给一张透明占位):
 * 「事件带的头像优先、没带的用资料里的」「读头像抛了不拖累这张卡」这两条换了形状仍在 —— 头像是引用,
 * 没有就整个不给(头像块收起),不再有透明占位。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { imageRefOf } from "../../images/image-store.js";
import { liveCardInputFromReport } from "../live-card-input-from-report.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);
const GARBAGE = new Uint8Array([1, 2, 3, 4]);
const PROFILE_AVATAR = `${"a".repeat(64)}.png`;

/** 一个只认图库收的图(`imageRefOf`)的存图口,记下存过什么。 */
function sink(opts: { failWith?: Error } = {}) {
	const put = vi.fn(async (bytes: Uint8Array) => {
		if (opts.failWith) throw opts.failWith;
		const ref = imageRefOf(bytes);
		return ref
			? { ok: true as const, ref }
			: ({ ok: false as const, code: "invalid", message: "不是图库收的图" } as never);
	});
	return { put };
}

const base = (images: ReturnType<typeof sink>) => ({
	status: "start" as const,
	authorName: "抖音甲",
	images,
});

describe("liveCardInputFromReport — 每一格", () => {
	it("一份满的上报:每一格都在,图是引用、开播时刻是 ISO,键不多不少", async () => {
		const images = sink();
		const input = await liveCardInputFromReport(
			{
				title: "第一场",
				cover: PNG,
				category: "聊天",
				description: "简介",
				viewers: 10,
				totalViewers: 40,
				likes: 3,
				author: { name: "事件里的名字", avatar: PNG_B },
			},
			{
				...base(images),
				status: "end",
				startedAt: Date.UTC(2026, 8, 24, 4, 0, 0),
				followers: 12_345,
				followersDelta: 128,
				profileAvatar: PROFILE_AVATAR,
			},
		);
		expect(input).toStrictEqual({
			status: "end",
			creator: { name: "抖音甲", avatar: imageRefOf(PNG_B) },
			title: "第一场",
			category: "聊天",
			description: "简介",
			cover: { ref: imageRefOf(PNG) },
			startedAt: "2026-09-24T04:00:00.000Z",
			currentViewers: 10,
			totalViewers: 40,
			likes: 3,
			followers: 12_345,
			followersDelta: 128,
		});
	});

	it("什么都没报:只有状态与主播名,没有别的键(缺了就缺键)", async () => {
		const images = sink();
		expect(await liveCardInputFromReport({}, base(images))).toStrictEqual({
			status: "start",
			creator: { name: "抖音甲" },
		});
		expect(images.put).not.toHaveBeenCalled();
	});

	it("人数报了 0 就是 0(真数,留着);没报才没有", async () => {
		const input = await liveCardInputFromReport({ viewers: 0, likes: 0 }, base(sink()));
		expect(input).toMatchObject({ currentViewers: 0, likes: 0 });
		expect(Object.hasOwn(input, "totalViewers")).toBe(false);
	});
});

describe("liveCardInputFromReport — 开播时刻(毫秒 → ISO)", () => {
	it("毫秒转成 ISO", async () => {
		const input = await liveCardInputFromReport(
			{},
			{ ...base(sink()), startedAt: Date.UTC(2026, 0, 1, 0, 0, 0) },
		);
		expect(input.startedAt).toBe("2026-01-01T00:00:00.000Z");
	});

	/** 在播表 / 场次里是毫秒,坏值(NaN)不能把整张卡弄抛:当没有开播时刻。 */
	it("不是有效时刻(没给、NaN)→ 没有这个键", async () => {
		for (const startedAt of [undefined, Number.NaN]) {
			const input = await liveCardInputFromReport({}, { ...base(sink()), startedAt });
			expect(Object.hasOwn(input, "startedAt"), String(startedAt)).toBe(false);
		}
	});
});

describe("liveCardInputFromReport — 主播头像", () => {
	it("事件带了头像且图库收:用它,订阅资料里的不用", async () => {
		const input = await liveCardInputFromReport(
			{ author: { avatar: PNG_B } },
			{ ...base(sink()), profileAvatar: PROFILE_AVATAR },
		);
		expect(input.creator.avatar).toBe(imageRefOf(PNG_B));
	});

	it("事件没带头像:订阅资料里的引用顶上,不存图", async () => {
		const images = sink();
		const input = await liveCardInputFromReport(
			{ author: { name: "只带了名字" } },
			{ ...base(images), profileAvatar: PROFILE_AVATAR },
		);
		expect(input.creator.avatar).toBe(PROFILE_AVATAR);
		expect(images.put).not.toHaveBeenCalled();
	});

	it("事件带的头像图库不收(格式不认):退到订阅资料里的", async () => {
		const input = await liveCardInputFromReport(
			{ author: { avatar: GARBAGE } },
			{ ...base(sink()), profileAvatar: PROFILE_AVATAR },
		);
		expect(input.creator.avatar).toBe(PROFILE_AVATAR);
	});

	it("哪儿都没有头像:creator 里没有 avatar 这个键(头像块收起,不给透明占位)", async () => {
		const input = await liveCardInputFromReport({ author: { avatar: GARBAGE } }, base(sink()));
		expect(input.creator).toStrictEqual({ name: "抖音甲" });
	});
});

describe("liveCardInputFromReport — 封面", () => {
	it("封面是引用({ ref });没有 url", async () => {
		const input = await liveCardInputFromReport({ cover: PNG }, base(sink()));
		expect(input.cover).toStrictEqual({ ref: imageRefOf(PNG) });
	});

	it("图库不收的封面(格式不认):没有 cover 这个键,出卡那头画「暂无封面」", async () => {
		const input = await liveCardInputFromReport({ cover: GARBAGE }, base(sink()));
		expect(Object.hasOwn(input, "cover")).toBe(false);
	});

	it("没报封面:不存图", async () => {
		const images = sink();
		await liveCardInputFromReport({ title: "x" }, base(images));
		expect(images.put).not.toHaveBeenCalled();
	});
});

describe("liveCardInputFromReport — 图库写盘失败", () => {
	/** 磁盘写失败是抛错(与 `postFromReport` 同一条规矩):这一次出卡失败,装配降级成纯文字。 */
	it("存图口抛错 → 往外抛,不吞", async () => {
		await expect(
			liveCardInputFromReport({ cover: PNG }, base(sink({ failWith: new Error("磁盘满了") }))),
		).rejects.toThrow("磁盘满了");
	});
});

describe("liveCardInputFromReport — 存图口回的不是 invalid", () => {
	/** 今天生产里拿到的口是 `deferImageWrites` 的 `sink`,只回 ok / invalid;真图库直接传进来时盘满回的是 unavailable。 */
	const opts = {
		status: "start" as const,
		authorName: "抖音甲",
		images: {
			put: async () => ({
				ok: false as const,
				code: "unavailable" as const,
				message: "图库写盘失败:盘满了",
			}),
		},
	};

	it("封面存不下来(unavailable):抛、原因带着,不是悄悄没有封面", async () => {
		await expect(liveCardInputFromReport({ cover: PNG }, opts)).rejects.toThrow("盘满了");
	});

	it("事件带的头像存不下来(unavailable):抛,不是悄悄换成资料里那张", async () => {
		await expect(liveCardInputFromReport({ author: { avatar: PNG } }, opts)).rejects.toThrow(
			"盘满了",
		);
	});
});
