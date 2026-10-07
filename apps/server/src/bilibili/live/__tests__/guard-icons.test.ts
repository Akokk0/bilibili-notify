/**
 * 大航海徽章图标(`createGuardIcons`):B 站这边运行时把三档的图抓进图库,用图库引用交给会员卡。
 * 抓图服务用假的(不联网);时间经 `now` 注入,不真等。
 */

import { BILIBILI_GUARD_PROGRAM, fail, type ImageRef, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { createGuardIcons, GUARD_ICON_RETRY_INTERVAL_MS } from "../guard-icons.js";

const TIERS = Array.isArray(BILIBILI_GUARD_PROGRAM.tiers) ? BILIBILI_GUARD_PROGRAM.tiers : [];
/** 给每个地址一个稳定的假引用(64 位 hex + 扩展名)。 */
const refOf = (url: string): ImageRef =>
	`${Buffer.from(url).toString("hex").padEnd(64, "0").slice(0, 64)}.png`;
const urlOf = (key: string) => TIERS.find((t) => t.key === key)?.icon?.url ?? "";

type Reply = Awaited<ReturnType<Parameters<typeof createGuardIcons>[0]["images"]["fetchImage"]>>;

function setup(reply?: (url: string) => Reply | Promise<Reply>) {
	let clock = 1_000_000;
	const fetchImage = vi.fn(async (url: string) => (reply ? reply(url) : ok({ ref: refOf(url) })));
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const icons = createGuardIcons({ images: { fetchImage }, logger, now: () => clock });
	return { icons, fetchImage, logger, advance: (ms: number) => (clock += ms) };
}

describe("createGuardIcons", () => {
	it("抓到 → iconOf 给图库引用、refs() 含三张", async () => {
		const { icons } = setup();
		await icons.ensure();
		for (const tier of TIERS) {
			expect(icons.iconOf(tier.key)).toEqual({ ref: refOf(urlOf(tier.key)) });
		}
		expect(icons.refs().sort()).toEqual(TIERS.map((t) => refOf(urlOf(t.key))).sort());
	});

	it("抓不到 → iconOf 给 undefined、ensure() 不抛、日志里有失败的 code 与 message", async () => {
		const { icons, logger } = setup(() => fail("unavailable", "对端回了 HTTP 502: /x.png"));
		await expect(icons.ensure()).resolves.toBeUndefined();
		for (const tier of TIERS) expect(icons.iconOf(tier.key)).toBeUndefined();
		expect(icons.refs()).toEqual([]);
		const logged = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("unavailable");
		expect(logged).toContain("对端回了 HTTP 502");
	});

	it("间隔内再次 ensure() 不重抓,过了间隔会重抓", async () => {
		const { icons, fetchImage, advance } = setup(() => fail("timeout", "超时"));
		await icons.ensure();
		expect(fetchImage).toHaveBeenCalledTimes(3);
		advance(GUARD_ICON_RETRY_INTERVAL_MS - 1);
		await icons.ensure();
		expect(fetchImage).toHaveBeenCalledTimes(3);
		advance(1);
		await icons.ensure();
		expect(fetchImage).toHaveBeenCalledTimes(6);
	});

	it("并发两次 ensure() 只抓一轮", async () => {
		const { icons, fetchImage } = setup();
		await Promise.all([icons.ensure(), icons.ensure()]);
		expect(fetchImage).toHaveBeenCalledTimes(3);
	});

	it("部分成功:成的那两张可用,过了间隔只补缺的那张", async () => {
		const missing = urlOf("governor");
		let governorUp = false;
		const { icons, fetchImage, advance } = setup((url) =>
			url === missing && !governorUp
				? fail("not_found", "对端回了 HTTP 404")
				: ok({ ref: refOf(url) }),
		);
		await icons.ensure();
		expect(icons.iconOf("captain")).toEqual({ ref: refOf(urlOf("captain")) });
		expect(icons.iconOf("commander")).toEqual({ ref: refOf(urlOf("commander")) });
		expect(icons.iconOf("governor")).toBeUndefined();
		expect(icons.refs()).toHaveLength(2);

		governorUp = true;
		fetchImage.mockClear();
		advance(GUARD_ICON_RETRY_INTERVAL_MS);
		await icons.ensure();
		expect(fetchImage.mock.calls.map((c) => c[0])).toEqual([missing]);
		expect(icons.iconOf("governor")).toEqual({ ref: refOf(missing) });
		expect(icons.refs()).toHaveLength(3);
	});

	it("三张都在手里后 ensure() 不再抓", async () => {
		const { icons, fetchImage, advance } = setup();
		await icons.ensure();
		advance(GUARD_ICON_RETRY_INTERVAL_MS * 10);
		await icons.ensure();
		expect(fetchImage).toHaveBeenCalledTimes(3);
	});

	it("抓图服务自己抛了 → ensure() 照样不抛,别的图照抓,日志里有原因", async () => {
		const broken = urlOf("captain");
		const { icons, logger } = setup((url) => {
			if (url === broken) throw new Error("连接被重置");
			return ok({ ref: refOf(url) });
		});
		await expect(icons.ensure()).resolves.toBeUndefined();
		expect(icons.iconOf("captain")).toBeUndefined();
		expect(icons.refs()).toHaveLength(TIERS.length - 1);
		expect(logger.warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("连接被重置");
	});

	it("认不出的档位键给 undefined", async () => {
		const { icons } = setup();
		await icons.ensure();
		expect(icons.iconOf("admiral")).toBeUndefined();
		expect(icons.iconOf("")).toBeUndefined();
	});
});
