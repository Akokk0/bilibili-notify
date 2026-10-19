/**
 * 守卫 13 后半:重推原件(`history/repush/<日>/<行 id>.json`)里的**每种载荷**都有去向。
 *
 * 原件存的是 `NotificationPayload` 原样(图换成图库引用)。活的载荷一改名(3a-16 的 `forward-images` → `image-group`、
 * 段的判别键 `type` → `kind`),盘上的原件得由迁移跟着改 —— 漏一种不会报错:仓的 schema 认不得那一种,`load` 回 `null`,
 * 面板上「重推」按钮亮着、点下去读不动,而类型、测试、构建全绿。
 *
 * 判定函数(`keyed-record-finder.ts`)帮不上:原件里没有特性键 / 附加项 / 卡种这三套词表。这里换一个钉法:
 *
 * - 冻一份 0.x 的载荷种类表(`zero-vocabulary.ts` 的 `ZERO_PAYLOAD_KINDS`);
 * - 每一种造一份 0.x 形状的旧原件({@link ZERO_SNAPSHOTS},类型上缺一种就编译不过),摆进临时的第 0 代,走**整趟迁移**,
 *   再在迁出来的一代上开**真的重推原件仓**读它 —— 读得回来 = 过了现行的 schema;
 * - 现行的每一种载荷都得是某个 0.x 种类迁出来的,或者写明是 1.0 新加的({@link CURRENT_PAYLOAD_ORIGINS})。
 *
 * 什么时候红:
 * - 活的 `NotificationPayload` 多了一种 / 改了一种的名字 → {@link CURRENT_PAYLOAD_ORIGINS} 编译不过;填上以后,它声称的
 *   0.x 种类迁出来不是它 → 红(迁移没跟上);
 * - `ZERO_PAYLOAD_KINDS` 里的某一种没有夹具 → 编译不过;迁完读不回来(过不了现行 schema)→ 红;
 * - 小程序卡(`miniapp-card`)迁成原生分享(`native-share`):四格改名、补 appid;期望的 appid 从 B 站解析器 import,
 *   迁移冻住的值与解析器的值被这里钉成同一个。
 *
 * 夹具是自己编的,不是真实数据;输入不往 `zero-fixtures.ts` 里加(那份的产出钉着迁移修订号)。
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NotificationPayload } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { JPEG_BYTES, PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { QQ_MINI_APP_ID } from "../../bilibili/link-resolver.js";
import { createRepushStore } from "../../history/repush-store.js";
import { ZERO_PAYLOAD_KINDS, type ZeroPayloadKind } from "../zero-vocabulary.js";
import { useZeroSandbox } from "./support.js";

const sandbox = useZeroSandbox("bn-zero-repush-payloads-");

const DAY = "2026-06-10";
const CREATED_AT = `${DAY}T08:00:00.000Z`;

/** 每种 0.x 载荷各一份旧原件里的载荷(0.12 的形状:图是 `{ ref, mime, own? }`、段的判别键 `type`、图集 `forward-images` / `forward`)。 */
const ZERO_SNAPSHOTS: Record<ZeroPayloadKind, (id: string) => Record<string, unknown>> = {
	text: () => ({ kind: "text", text: "开播啦" }),
	image: () => ({
		kind: "image",
		image: { ref: "card.png", mime: "image/png" },
		caption: "卡片说明",
	}),
	composite: (id) => ({
		kind: "composite",
		segments: [
			{ type: "at-all" },
			{ type: "text", text: "正文" },
			{ type: "image", image: { ref: "card.png", mime: "image/png" } },
			{ type: "image", image: { ref: `${id}-0-2.jpg`, mime: "image/jpeg", own: true } },
			{ type: "link", href: "https://example.com/v", title: "视频" },
			{ type: "link", href: "https://example.com/bare" },
		],
	}),
	"forward-images": () => ({
		kind: "forward-images",
		images: [
			{ url: "https://example.com/1.jpg", width: 1080, height: 1920 },
			{ url: "https://example.com/2.jpg" },
		],
		forward: true,
	}),
	"miniapp-card": () => ({
		kind: "miniapp-card",
		title: "视频标题",
		desc: "简介",
		picUrl: "https://example.com/cover.jpg",
		path: "pages/video/video?bvid=BV1xx",
		jumpUrl: "https://example.com/video/BV1xx",
	}),
};

/**
 * 现行的每种载荷是 0.x 的哪一种迁出来的;1.0 新加、0.x 没有的写 `null`。键对 `NotificationPayload["kind"]` 是全的:
 * 活的载荷多一种、改一个名字,这里编译不过。
 */
const CURRENT_PAYLOAD_ORIGINS: Record<NotificationPayload["kind"], ZeroPayloadKind | null> = {
	text: "text",
	image: "image",
	composite: "composite",
	"image-group": "forward-images",
	"native-share": "miniapp-card",
};

/** 0.x 的名字:迁完的原件里一个都不该剩。 */
const ZERO_ONLY_NAMES = [
	'"forward-images"',
	'"forward"',
	'"type"',
	'"own"',
	'"mime"',
	'"v"',
	'"miniapp-card"',
	'"desc"',
	'"picUrl"',
	'"path"',
	'"jumpUrl"',
];

/** 每种 0.x 载荷各摆一份旧原件,整趟迁一次,再用真的重推原件仓逐份读回。 */
async function migrateAll() {
	const ids = Object.fromEntries(ZERO_PAYLOAD_KINDS.map((kind) => [kind, randomUUID()])) as Record<
		ZeroPayloadKind,
		string
	>;
	await sandbox.placeZeroBytes("history/img/card.png", PNG_BYTES);
	for (const zeroKind of ZERO_PAYLOAD_KINDS) {
		const id = ids[zeroKind];
		await sandbox.placeZeroBytes(`history/repush/${DAY}/${id}-0-2.jpg`, JPEG_BYTES);
		await sandbox.placeZero(`history/repush/${DAY}/${id}.json`, {
			v: 1,
			messages: [{ payload: ZERO_SNAPSHOTS[zeroKind](id), role: "main" }],
		});
	}
	await sandbox.migrate({ now: new Date("2026-06-15T12:00:00.000Z") });
	const library = makeHistoryImages(sandbox.target);
	const store = createRepushStore({
		dataRoot: sandbox.target,
		logger: silentLogger,
		images: library.repushImages,
		imageStore: library.imageStore,
	});
	return async (zeroKind: ZeroPayloadKind) => {
		const id = ids[zeroKind];
		const raw = await readFile(
			join(sandbox.target, "history", "repush", DAY, `${id}.json`),
			"utf8",
		);
		const loaded = await store.load(id, CREATED_AT, 1);
		return { raw, zeroPayload: ZERO_SNAPSHOTS[zeroKind](id), loaded: loaded?.messages[0]?.payload };
	};
}

describe("守卫 13 后半:重推原件的每种载荷都有去向", () => {
	it("冻住的 0.x 载荷种类每一种都有夹具", () => {
		expect(Object.keys(ZERO_SNAPSHOTS).sort()).toEqual([...ZERO_PAYLOAD_KINDS].sort());
	});

	it("0.x 的每种原件:迁完真的重推原件仓读得回来(过了现行的 schema)", async () => {
		const read = await migrateAll();
		for (const zeroKind of ZERO_PAYLOAD_KINDS) {
			expect((await read(zeroKind)).loaded, `${zeroKind} 迁完读不回来`).toBeDefined();
		}
	});

	it("现行的每种载荷都有交代:是某个 0.x 种类迁出来的那一种,没有两种 0.x 落到同一种", async () => {
		const origins = Object.entries(CURRENT_PAYLOAD_ORIGINS) as [
			NotificationPayload["kind"],
			ZeroPayloadKind | null,
		][];
		const read = await migrateAll();
		for (const [current, zeroKind] of origins) {
			if (zeroKind === null) continue;
			const { loaded } = await read(zeroKind);
			expect(loaded?.kind, `${zeroKind} → ${current}`).toBe(current);
		}
		const claimed = origins.flatMap(([, zeroKind]) => (zeroKind === null ? [] : [zeroKind]));
		// 0.x 的每一种都落进了现行的某一种(没有哪一种迁完没人认领),且一一对应。
		expect([...claimed].sort()).toEqual([...ZERO_PAYLOAD_KINDS].sort());
	});

	it("迁完的原件里 0.x 的名字一个不剩", async () => {
		const read = await migrateAll();
		for (const zeroKind of ZERO_PAYLOAD_KINDS) {
			const { raw } = await read(zeroKind);
			for (const name of ZERO_ONLY_NAMES)
				expect(raw, `${zeroKind} 迁完还有 ${name}`).not.toContain(name);
		}
	});

	it("图集:`forward-images` → `image-group`、`forward` → `mergeForward`,图的 url 与尺寸照搬", async () => {
		const { loaded } = await (await migrateAll())("forward-images");
		expect(loaded).toEqual({
			kind: "image-group",
			images: [
				{ url: "https://example.com/1.jpg", width: 1080, height: 1920 },
				{ url: "https://example.com/2.jpg" },
			],
			mergeForward: true,
		});
	});

	it("composite:段的判别键 `type` → `kind`,六段的种类与先后不变,`link` / `at-all` 照搬", async () => {
		const { loaded } = await (await migrateAll())("composite");
		if (loaded?.kind !== "composite") throw new Error("kind");
		expect(loaded.segments.map((seg) => seg.kind)).toEqual([
			"at-all",
			"text",
			"image",
			"image",
			"link",
			"link",
		]);
		expect(loaded.segments.filter((seg) => seg.kind !== "image")).toEqual([
			{ kind: "at-all" },
			{ kind: "text", text: "正文" },
			{ kind: "link", href: "https://example.com/v", title: "视频" },
			{ kind: "link", href: "https://example.com/bare" },
		]);
	});

	it("小程序卡 → 原生分享:四格改名、`title` 照搬、补 B 站 QQ 小程序的 appid", async () => {
		const { loaded, raw } = await (await migrateAll())("miniapp-card");
		expect(loaded).toEqual({
			kind: "native-share",
			appId: QQ_MINI_APP_ID,
			title: "视频标题",
			description: "简介",
			imageUrl: "https://example.com/cover.jpg",
			pagePath: "pages/video/video?bvid=BV1xx",
			webUrl: "https://example.com/video/BV1xx",
		});
		// 磁盘上的也是新形状,不只是读回来过了 schema。
		expect(JSON.parse(raw).messages[0].payload.appId).toBe(QQ_MINI_APP_ID);
	});
});
