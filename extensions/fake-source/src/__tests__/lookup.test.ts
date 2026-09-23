/**
 * 假源的解析门:普通的字现编三个候选,四个魔法词各演一种宿主要接住的样子。
 *
 * 它存在的意义是让主人在真机上看见 ADR-0019 ③ 的每一条路 —— 所以这里钉的是「每条路都真的
 * 走得到」:三个候选各缺一样东西(面板要各画一种样子),空 / 慢 / 坏 / 乱 各落到宿主的一个分支。
 */

import { readFile } from "node:fs/promises";
import type { ExtensionSubscriptionCandidate } from "@bilibili-notify/extension";
import { describe, expect, it, vi } from "vite-plus/test";
import { bootFakeSource } from "./harness.js";
import { hostComplaints } from "./host-rules.js";

async function candidatesFor(query: string): Promise<readonly ExtensionSubscriptionCandidate[]> {
	return await bootFakeSource().lookup(query);
}

describe("普通的字", () => {
	it("回三个候选:有头像有粉丝、有头像没粉丝、没头像有粉丝,名字里都带着输入的字", async () => {
		const found = await candidatesFor("阿梓");
		expect(found).toHaveLength(3);
		const [full, noFans, noAvatar] = found;
		expect(full).toMatchObject({ avatar: expect.any(String), fans: expect.any(Number) });
		expect(noFans?.avatar).toEqual(expect.any(String));
		expect(noFans && "fans" in noFans).toBe(false);
		expect(noAvatar?.fans).toEqual(expect.any(Number));
		expect(noAvatar && "avatar" in noAvatar).toBe(false);
		for (const one of found) expect(one.name).toContain("阿梓");
	});

	/**
	 * 同一句字永远是同一组人 —— 主人删了重建、隔天再查,拿到的 id 一样,判重那条路才走得到。
	 * 两次各起一个新的假源,证明它是从字里算出来的,不是进程里记着的。
	 */
	it("同一句字查两次 id 一样(换一个新起的假源也一样);换一句字,id 全换", async () => {
		const ids = async (query: string) => (await candidatesFor(query)).map((c) => c.id);
		const first = await ids("阿梓");
		expect(await ids("阿梓")).toEqual(first);
		expect(new Set(first).size).toBe(3);
		const other = await ids("七海");
		for (const id of other) expect(first).not.toContain(id);
	});

	/** 宿主收的 q 最长 1024 字,而候选的 id 上限 256、名字上限 128 —— 超了整次回 502。 */
	it("1024 字的查询:id 不超过 256 字,名字不超过 128 字", async () => {
		for (const one of await candidatesFor("长".repeat(1024))) {
			expect(one.id.length).toBeLessThanOrEqual(256);
			expect(one.name.length).toBeGreaterThan(0);
			expect(one.name.length).toBeLessThanOrEqual(128);
		}
	});

	/** 过不了这道闸,面板上就不是三个候选,而是一句「候选不合规矩」。长的、带 emoji 的也算上。 */
	it("三个候选都过得了宿主那道形状闸(头像按魔数核过)", async () => {
		for (const query of ["阿梓", "https://example.com/user/abc?x=1", "长".repeat(1024), "😀"]) {
			expect(hostComplaints(await candidatesFor(query)), query).toEqual([]);
		}
	});

	it("头像是 64×64 的真 png,每张都远小于宿主的 128 KiB", async () => {
		const avatars = (await candidatesFor("阿梓")).flatMap((c) => (c.avatar ? [c.avatar] : []));
		expect(avatars).toHaveLength(2);
		for (const avatar of avatars) {
			expect(avatar.startsWith("data:image/png;base64,")).toBe(true);
			const bytes = Buffer.from(avatar.slice(avatar.indexOf(",") + 1), "base64");
			// IHDR 紧跟在 8 字节签名与 8 字节块头之后:宽、高各 4 字节大端。
			expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
			expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([64, 64]);
			expect(avatar.length).toBeLessThan(4 * 1024);
		}
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
	 * 主人只从输入框那句提示里知道有这四个词 —— 改了词忘了改提示,那条路在真机上就没人走得到。
	 * 宿主收的提示最多 40 字,超了整份清单读不了。
	 */
	it("清单里那句输入框提示点名了四个魔法词,且不超过 40 字", async () => {
		const manifest = JSON.parse(
			await readFile(new URL("../../extension.json", import.meta.url), "utf8"),
		);
		const placeholder: string = manifest.contributes.subscription.display.lookupPlaceholder;
		expect(placeholder.length).toBeLessThanOrEqual(40);
		for (const word of ["空", "慢", "坏", "乱"]) expect(placeholder).toContain(word);
	});

	/** 认不出任何人 —— 面板那头说「没找到」。 */
	it("空:回空表", async () => {
		expect(await candidatesFor("空")).toEqual([]);
	});

	/**
	 * 平台那头出了错 —— 宿主把原话接在「拓展查询出错:」后面给到面板(502)。所以这句要读起来像真
	 * 平台的毛病,主人才看得出那条路通了;同步抛还是交回被拒的 Promise 宿主都接,这里两种都认。
	 */
	it("坏:抛一个像真平台出错的错(cookie 过期),原话能被宿主接住", async () => {
		const fake = bootFakeSource();
		const run = new Promise((resolve) => resolve(fake.lookup("坏")));
		await expect(run).rejects.toThrow(/cookie.*过期/);
	});

	/**
	 * 拓展的 bug —— 交回的候选宿主必须拒(502「候选不合规矩」,并点名哪儿不对)。SVG 头像是最该拦的
	 * 那种:建成订阅后头像从同源地址取,同源的 SVG 被直接打开会跑脚本(ADR-0019 决策 49)。
	 */
	it("乱:交回一串宿主必须拒的候选,里面有一张 SVG 头像", async () => {
		const found = await candidatesFor("乱");
		expect(found.length).toBeGreaterThan(0);
		expect(found.some((c) => c.avatar?.startsWith("data:image/svg+xml"))).toBe(true);
		expect(hostComplaints(found)).toContainEqual(expect.stringMatching(/avatar 不是位图/));
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
			const pending = Promise.resolve(bootFakeSource().lookup("慢", controller.signal));
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
		const run = Promise.resolve(bootFakeSource().lookup("慢", controller.signal));
		await expect(run).rejects.toBe(reason);
	});
});
