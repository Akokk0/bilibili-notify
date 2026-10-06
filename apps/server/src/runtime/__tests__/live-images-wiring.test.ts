/**
 * **真装配里,拓展直播的封面与头像登记成了图库的一家**(接线守卫,同 `post-images-wiring.test.ts` /
 * `profile-images-wiring.test.ts`;ADR-0021 决策 22 / 24 下 2026-10-05 的 🔗,㉒c)。
 *
 * 拓展直播卡是中立输入,封面与事件带来的作者头像经 `liveImages` 存进图库、输入里只放引用。和作品不同,直播是**长在场的**:
 * 一场可以播过 24 小时,周期「正在直播」卡几小时后还要用封面,所以这一家登记的名单是**在播表里此刻那些行的封面与
 * 事件头像**(字节算得出存进图库后的引用),不是恒空。登记那一行 `register(…)` 的各种写歪(没登记、名单恒空、名单写成永远
 * 引用、名单抛错)症状都是静默的(周期卡拿不到封面,或清扫整轮一张不删),单测证明不了,所以走真的 `createAppRuntime`:
 *
 * - 在播表里有这一行:它的封面与头像,过了宽限期清扫也留着;
 * - 这一场下播(行出表)之后:下一轮清扫收走;
 * - 存进去的图,宽限期内清扫不删(在途的那一张卡不会被扫走)。
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { putImage } from "../../__tests__/support/chat-images.js";
import { png } from "../../__tests__/support/report-images.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { IMAGE_GRACE_MS, imageRefOf } from "../../images/image-store.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";
import { dataPath } from "../roots.js";

let dataDir: string;
let runtime: AppRuntime;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-live-images-wiring-"));
	runtime = createAppRuntime(BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }), {
		dataRoot: dataDir,
	});
});
afterEach(async () => {
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

const justAfter = (ms: number) => new Date(Date.now() + ms);
const PAST_GRACE = IMAGE_GRACE_MS + 60 * 60 * 1000;
const imagesOnDisk = async () => (await readdir(dataPath(dataDir, "images"))).sort();

/** 拓展报一场开播(进在播表)。 */
function reportLiveStart(value: { cover?: Uint8Array; author?: { avatar?: Uint8Array } }): void {
	runtime.bus.emit("subscription-reported", {
		extensionId: "douyin",
		externalId: "sec-uid-1",
		subscriptionIds: ["sub-1"],
		report: {
			kind: "liveStart",
			value: { url: "https://live.douyin.com/1", startedAt: Date.now(), ...value },
		},
	});
}

describe("createAppRuntime 里的拓展直播图", () => {
	it("存进去的图,宽限期内清扫不删", async () => {
		const ref = await putImage(runtime.liveImages, png(16, 9, 1));
		const early = await runtime.imageStore.sweep({
			now: justAfter(IMAGE_GRACE_MS - 60 * 60 * 1000),
		});
		expect(early).toEqual({ removed: [], removedBytes: 0, referenced: 0, inGrace: 1 });
		expect(await imagesOnDisk()).toEqual([ref]);
	});

	it("在播表里有这一行:它的封面与事件头像,过了宽限期清扫也留着", async () => {
		const [cover, avatar, stray] = [png(16, 9, 1), png(8, 8, 2), png(4, 4, 3)];
		const coverRef = await putImage(runtime.liveImages, cover);
		const avatarRef = await putImage(runtime.liveImages, avatar);
		const strayRef = await putImage(runtime.liveImages, stray);
		reportLiveStart({ cover, author: { avatar } });
		expect(runtime.extensionLive.list()).toHaveLength(1);

		// 验红:把 bootstrap.ts 里 `liveImages` 的名单改成 `[]`,封面与头像也被收走,这条红。
		const swept = await runtime.imageStore.sweep({ now: justAfter(PAST_GRACE) });
		expect(swept.removed).toEqual([strayRef]);
		expect(swept.referenced).toBe(2);
		expect(await imagesOnDisk()).toEqual([coverRef, avatarRef].sort());
		expect(coverRef).toBe(imageRefOf(cover));
	});

	it("这一场下播(行出表)之后:封面与头像下一轮清扫收走", async () => {
		const [cover, avatar] = [png(16, 9, 1), png(8, 8, 2)];
		const coverRef = await putImage(runtime.liveImages, cover);
		const avatarRef = await putImage(runtime.liveImages, avatar);
		reportLiveStart({ cover, author: { avatar } });
		runtime.bus.emit("subscription-reported", {
			extensionId: "douyin",
			externalId: "sec-uid-1",
			subscriptionIds: ["sub-1"],
			report: { kind: "liveEnd", value: { url: "https://live.douyin.com/1" } },
		});
		expect(runtime.extensionLive.list()).toHaveLength(0);

		const swept = await runtime.imageStore.sweep({ now: justAfter(PAST_GRACE) });
		expect([...swept.removed].sort()).toEqual([coverRef, avatarRef].sort());
		expect(await imagesOnDisk()).toEqual([]);
	});

	/** 图库不收的字节(格式不认)算不出引用:名单里跳过它,不抛、不让整轮清扫一张不删。 */
	it("在播表里有认不得的字节(拓展交的不是图):名单跳过它,清扫照常", async () => {
		const stray = png(4, 4, 3);
		const strayRef = await putImage(runtime.liveImages, stray);
		reportLiveStart({ cover: new Uint8Array([1, 2, 3, 4]) });

		const swept = await runtime.imageStore.sweep({ now: justAfter(PAST_GRACE) });
		expect(swept.removed).toEqual([strayRef]);
	});
});
