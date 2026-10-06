/**
 * **真装配里,拓展作品的配图登记成了图库的一家**(接线守卫,同 `profile-images-wiring.test.ts`;ADR-0021
 * 决策 22 下 2026-10-05 的 🔗,㉑d)。
 *
 * 作品卡是 `Post`,配图、封面、事件带来的头像经 `postImages` 存进图库、`Post` 里只放引用。作品是**在途数据**:
 * 推完就没有谁引用它的图,所以这一家登记时名单恒空 —— 图靠宽限期活到卡片画完,过了宽限期由清扫收走。
 * 登记那一行 `register(…)` 的各种写歪(没登记、名单写成永远引用、名单抛错)症状都是静默的(漏图,或清扫整轮
 * 一张不删),单测证明不了,所以这里走真的 `createAppRuntime`:
 *
 * - 存进去的图,宽限期内清扫不删(这就是「在途」的保证:卡片出到一半不会被扫走);
 * - 过了宽限期、没有谁引用,下一轮清扫收走(不永久占盘);
 * - 经 `postFromReport` 存的配图 / 封面 / 头像,字节在真图库里读得回来,过了宽限期同样收走。
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { putImage } from "../../__tests__/support/chat-images.js";
import { gif, png } from "../../__tests__/support/report-images.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { IMAGE_GRACE_MS } from "../../images/image-store.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";
import { postFromReport } from "../post-from-report.js";
import { dataPath } from "../roots.js";

let dataDir: string;
let runtime: AppRuntime;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-post-images-wiring-"));
	runtime = createAppRuntime(BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }), {
		dataRoot: dataDir,
	});
});
afterEach(async () => {
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

const T0 = new Date("2026-10-05T12:00:00.000Z");
/** 清扫的时钟:`now` 由调用方给,测试里不依赖真时间的流逝。 */
const justAfter = (ms: number) => new Date(Date.now() + ms);
const imagesOnDisk = async () => (await readdir(dataPath(dataDir, "images"))).sort();

describe("createAppRuntime 里的作品配图", () => {
	it("存进去的图,宽限期内清扫不删;过了宽限期没人引用,下一轮收走", async () => {
		const ref = await putImage(runtime.postImages, png(10, 10));

		const early = await runtime.imageStore.sweep({
			now: justAfter(IMAGE_GRACE_MS - 60 * 60 * 1000),
		});
		expect(early).toEqual({ removed: [], removedBytes: 0, referenced: 0, inGrace: 1 });
		expect(await imagesOnDisk()).toEqual([ref]);

		const late = await runtime.imageStore.sweep({
			now: justAfter(IMAGE_GRACE_MS + 60 * 60 * 1000),
		});
		expect(late.removed).toEqual([ref]);
		expect(await imagesOnDisk()).toEqual([]);
	});

	it("经 postFromReport 存的配图、封面、事件头像都落进真图库,字节读得回来;过了宽限期一并收走", async () => {
		const [cover, shot, avatar] = [png(16, 9, 1), gif(4, 4, 2), png(8, 8, 3)];
		const post = await postFromReport(
			{
				id: "p1",
				url: "https://www.douyin.com/video/p1",
				publishedAt: T0.getTime(),
				images: [shot],
				video: { cover },
				author: { avatar },
			},
			{ authorName: "作者甲", images: runtime.postImages },
		);
		const refs = [post.images?.[0]?.ref, post.video?.cover.ref, post.creator.avatar];
		expect(refs.every((ref) => typeof ref === "string")).toBe(true);
		expect(await imagesOnDisk()).toEqual((refs as string[]).sort());
		for (const [ref, original] of [
			[refs[0], shot],
			[refs[1], cover],
			[refs[2], avatar],
		] as const) {
			const read = await runtime.imageStore.read(ref as string);
			expect(read && Buffer.from(read.bytes).equals(Buffer.from(original)), ref).toBe(true);
		}

		const swept = await runtime.imageStore.sweep({
			now: justAfter(IMAGE_GRACE_MS + 60 * 60 * 1000),
		});
		expect([...swept.removed].sort()).toEqual((refs as string[]).sort());
		expect(await imagesOnDisk()).toEqual([]);
	});
});
