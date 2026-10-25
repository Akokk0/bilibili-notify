/**
 * 假源的解析门:普通的字现编三个候选,四个魔法词各演一种宿主要接住的样子。
 *
 * 它存在的意义是让主人在真机上看见 ADR-0019 ③ 的每一条路 —— 所以这里钉的是「每条路都真的
 * 走得到」:三个候选各缺一样东西(面板要各画一种样子),空 / 慢 / 坏 / 乱 各落到宿主的一个分支。
 */

import { readFile } from "node:fs/promises";
import type { CreatorCandidate } from "@bilibili-notify/extension";
import { describe, expect, it, vi } from "vite-plus/test";
import { bootFakeSource } from "./harness.js";
import { hostComplaints } from "./host-rules.js";

async function candidatesFor(query: string): Promise<readonly CreatorCandidate[]> {
	return await bootFakeSource().candidates(query);
}

describe("普通的字", () => {
	it("回三个候选:有头像有粉丝、有头像没粉丝、没头像有粉丝,名字里都带着输入的字", async () => {
		const found = await candidatesFor("阿梓");
		expect(found).toHaveLength(3);
		const [full, noFans, noAvatar] = found;
		expect(full).toMatchObject({ avatar: expect.any(String), followers: expect.any(Number) });
		expect(noFans?.avatar).toEqual(expect.any(String));
		expect(noFans && "followers" in noFans).toBe(false);
		expect(noAvatar?.followers).toEqual(expect.any(Number));
		expect(noAvatar && "avatar" in noAvatar).toBe(false);
		for (const one of found) expect(one.name).toContain("阿梓");
	});

	/**
	 * 同一句字永远是同一组人 —— 主人删了重建、隔天再查,拿到的 id 一样,判重那条路才走得到。
	 * 两次各起一个新的假源,证明它是从字里算出来的,不是进程里记着的。
	 */
	it("同一句字查两次 id 一样(换一个新起的假源也一样);换一句字,id 全换", async () => {
		const ids = async (query: string) => (await candidatesFor(query)).map((c) => c.externalId);
		const first = await ids("阿梓");
		expect(await ids("阿梓")).toEqual(first);
		expect(new Set(first).size).toBe(3);
		const other = await ids("七海");
		for (const id of other) expect(first).not.toContain(id);
	});

	/** 宿主收的 q 最长 1024 字,而候选的 externalId 上限 256、名字上限 128 —— 超了整次回 502。 */
	it("1024 字的查询:externalId 不超过 256 字,名字不超过 128 字", async () => {
		for (const one of await candidatesFor("长".repeat(1024))) {
			expect(one.externalId.length).toBeLessThanOrEqual(256);
			expect(one.name.length).toBeGreaterThan(0);
			expect(one.name.length).toBeLessThanOrEqual(128);
		}
	});

	/** 过不了这道闸,面板上就不是三个候选,而是一句「候选不合规矩」。长的、带 emoji 的也算上。 */
	it("三个候选都过得了宿主那道形状闸(头像是图库引用)", async () => {
		for (const query of ["阿梓", "https://example.com/user/abc?x=1", "长".repeat(1024), "😀"]) {
			expect(hostComplaints(await candidatesFor(query)), query).toEqual([]);
		}
	});

	/**
	 * 头像先 `storeImage` 存进图库、交引用:引用背后是 64×64 的真 png,每张都远小于宿主那 8 MiB;
	 * 同一句字两次拿到的引用一样(引用是内容的摘要)。
	 */
	it("头像是图库引用,背后是 64×64 的真 png", async () => {
		const fake = bootFakeSource();
		const avatars = (await fake.candidates("阿梓")).flatMap((c) => (c.avatar ? [c.avatar] : []));
		expect(avatars).toHaveLength(2);
		for (const avatar of avatars) {
			const bytes = Buffer.from(fake.imageBytes(avatar) ?? []);
			// IHDR 紧跟在 8 字节签名与 8 字节块头之后:宽、高各 4 字节大端。
			expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
			expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([64, 64]);
			expect(bytes.length).toBeLessThan(4 * 1024);
		}
		const again = (await fake.candidates("阿梓")).flatMap((c) => (c.avatar ? [c.avatar] : []));
		expect(again).toEqual(avatars);
	});

	/** 候选最多 10 个(宿主的上限);三个远没到,钉住免得以后现编多了不自知。 */
	it("候选不超过 10 个", async () => {
		expect((await candidatesFor("阿梓")).length).toBeLessThanOrEqual(10);
	});

	it("图库存不下头像:回失败的结果形状,不抛", async () => {
		const fake = bootFakeSource([], { refuseStore: () => "图库满了" });
		const found = await fake.searchCreators("阿梓");
		expect(found).toMatchObject({ ok: false, code: "unavailable" });
		expect(found.ok ? "" : found.message).toContain("图库满了");
	});

	it("截短名字时不把 emoji 劈成半个", async () => {
		const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		for (const one of await candidatesFor("😀".repeat(512))) {
			expect(one.name).not.toMatch(loneSurrogate);
		}
	});
});

describe("四个魔法词", () => {
	/**
	 * 主人从拓展视图里的说明知道有这四个词。搜人输入框改由核心拼通用提示,这句说明不能再跟着
	 * 那份旧占位文案一起丢。
	 */
	it("简中视图的 notice 点名了四个魔法词", async () => {
		const locale = JSON.parse(
			await readFile(new URL("../../locales/zh-CN.json", import.meta.url), "utf8"),
		);
		const notice: string = locale["view.notice"];
		for (const word of ["空", "慢", "坏", "乱"]) expect(notice).toContain(word);
	});

	/** 认不出任何人 —— 面板那头说「没找到」(成功的空表,不是失败)。 */
	it("空:回成功的空表", async () => {
		expect(await bootFakeSource().searchCreators("空")).toEqual({ ok: true, candidates: [] });
	});

	/**
	 * 平台那头出了错 —— 宿主把原话接在「拓展查询出错:」后面给到面板(502)。所以这句要读起来像真
	 * 平台的毛病,主人才看得出那条路通了;第 3 版里失败回结果形状、不抛。
	 */
	it("坏:回一个像真平台出错的失败(cookie 过期),原话在 message 里", async () => {
		const found = await bootFakeSource().searchCreators("坏");
		expect(found).toMatchObject({ ok: false, code: "unauthorized" });
		expect(found.ok ? "" : found.message).toMatch(/cookie.*过期/);
	});

	/**
	 * 拓展的 bug —— 交回的候选宿主必须拒(`invalid`,并点名哪儿不对)。头像不是图库引用的形状是最该拦的
	 * 那种:引用会被宿主当成图库里的文件名去取。
	 */
	it("乱:交回一串宿主必须拒的候选,里面有一个头像不是图库引用", async () => {
		const found = await candidatesFor("乱");
		expect(found.length).toBeGreaterThan(0);
		expect(hostComplaints(found)).toContainEqual(expect.stringMatching(/avatar 不是图库引用/));
		expect(hostComplaints(found)).toContainEqual(expect.stringMatching(/followers/));
	});

	/**
	 * 平台卡住了 —— 宿主等满 15 秒回面板 504,同时中止 signal。它得一直不回,中止时按 signal 的
	 * reason 拒掉(手上的活接着 signal 停),而且**不靠定时器**:宿主不等了之后,一只没人清的
	 * 定时器就是拓展停用后还留在进程里的幽灵。
	 */
	it("慢:signal 不中止就永远不回、也不起定时器;中止时按 signal 的 reason 拒掉", async () => {
		vi.useFakeTimers();
		try {
			const controller = new AbortController();
			let settled = false;
			const pending = bootFakeSource().searchCreators("慢", controller.signal);
			pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			// 远过宿主那 15 秒。
			await vi.advanceTimersByTimeAsync(60_000);
			expect(settled).toBe(false);
			expect(vi.getTimerCount()).toBe(0);

			const reason = new DOMException("解析门超过 15 秒没回,BN 不等了", "TimeoutError");
			controller.abort(reason);
			await expect(pending).rejects.toBe(reason);
		} finally {
			vi.useRealTimers();
		}
	});

	it("慢:交进来时 signal 已经中止了 → 当场按它的 reason 拒掉", async () => {
		const controller = new AbortController();
		const reason = new DOMException("拓展 fake-source 停用了", "AbortError");
		controller.abort(reason);
		await expect(bootFakeSource().searchCreators("慢", controller.signal)).rejects.toBe(reason);
	});
});

describe("来源停了", () => {
	it("stop 之后搜人回「来源没在跑」的失败,不抛", async () => {
		const fake = bootFakeSource();
		await fake.stop();
		const found = await fake.searchCreators("阿梓");
		expect(found).toMatchObject({ ok: false, code: "unavailable" });
		expect(found.ok ? "" : found.message).toContain("来源没在跑");
	});
});
