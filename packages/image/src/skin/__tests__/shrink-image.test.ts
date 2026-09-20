/**
 * 压图那一档(`shrink-image.ts`)。用假浏览器跑 —— 这一层要钉的是**退让阶梯与放弃条件**,
 * 不是 webp 编码器本身好不好。
 *
 * 判据都对着一个静默失败:①「压完还是超」要老老实实回 `null`(别把一张注定被 Chrome
 * 丢掉的值交出去);② 图渲染不出来时 Chrome 画的是个**小破图标**,那玩意儿当然「塞得
 * 进预算」—— 拿它当压好的图,主人看到的就是一张破图标铺满卡片;③ 每开一个 page 都得关,
 * 漏一个就是一个浏览器标签永远不回收。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import type { PuppeteerLike } from "../../puppeteer";
import { shrinkImageForCssVar } from "../shrink-image";

const SRC = `data:image/png;base64,${"A".repeat(3_000_000)}`;

/** 假浏览器:每次 `screenshot` 吐 `sizes` 里的下一个字节数;`box` 可调。 */
function fakePup(opts: {
	sizes: number[];
	box?: { x: number; y: number; width: number; height: number } | null;
	noElement?: boolean;
}) {
	const html: string[] = [];
	const shots: Array<{ type?: string; quality?: number; omitBackground?: boolean }> = [];
	let opened = 0;
	let closed = 0;
	let i = 0;
	const pup: PuppeteerLike = {
		page: vi.fn(async () => {
			opened += 1;
			return {
				setContent: vi.fn(async (h: string) => {
					html.push(h);
				}),
				waitForFunction: vi.fn(async () => undefined),
				$: vi.fn(async () =>
					opts.noElement
						? null
						: {
								boundingBox: async () =>
									opts.box === undefined ? { x: 0, y: 0, width: 600, height: 400 } : opts.box,
								dispose: async () => {},
							},
				),
				screenshot: vi.fn(
					async (o?: { type?: string; quality?: number; omitBackground?: boolean }) => {
						shots.push({
							type: o?.type,
							quality: o?.quality,
							omitBackground: o?.omitBackground,
						});
						const n = opts.sizes[Math.min(i, opts.sizes.length - 1)] as number;
						i += 1;
						return Buffer.alloc(n, 0x61);
					},
				),
				close: vi.fn(async () => {
					closed += 1;
				}),
			};
		}),
	};
	return { pup, html, shots, opened: () => opened, closed: () => closed };
}

/** base64 之后的字符数(给预算算数用)。 */
const b64len = (bytes: number) => Math.ceil(bytes / 3) * 4;

describe("shrinkImageForCssVar", () => {
	it("压出来是 webp 的 data URL,而且真的按预算收", async () => {
		const f = fakePup({ sizes: [30_000] });
		const out = await shrinkImageForCssVar(f.pup, SRC, 1_000_000);
		expect(out?.startsWith("data:image/webp;base64,")).toBe(true);
		expect((out as string).length).toBeLessThanOrEqual(1_000_000);
		expect(f.shots[0]).toEqual({ type: "webp", quality: 82, omitBackground: true });
		// 第一档就够 → 只开一次
		expect(f.opened()).toBe(1);
	});

	it("第一档塞不进就往下退,退到塞得进为止", async () => {
		// 预算刚好容得下第三档
		const budget = b64len(300_000) + "data:image/webp;base64,".length;
		const f = fakePup({ sizes: [900_000, 500_000, 300_000] });
		const out = await shrinkImageForCssVar(f.pup, SRC, budget);
		expect(out).not.toBeNull();
		expect(f.shots.map((s) => s.quality)).toEqual([82, 72, 62]);
		// 每一档都要开 —— 漏一档就是「退让之后透明丢了」,而画面只在叠图的皮肤上才看得出来。
		expect(f.shots.every((s) => s.omitBackground === true)).toBe(true);
		// 宽度也跟着一档档收
		expect(f.html[0]).toContain("max-width:1200px");
		expect(f.html[2]).toContain("max-width:640px");
	});

	it("全档都塞不进 → null(交出去等于让 Chrome 再丢一次,而且没人知道)", async () => {
		const f = fakePup({ sizes: [9_000_000] });
		expect(await shrinkImageForCssVar(f.pup, SRC, 1000)).toBeNull();
		expect(f.shots).toHaveLength(4);
	});

	it("图渲染不出来(小破图标)→ null,别把破图标当成压好的图", async () => {
		const f = fakePup({ sizes: [100], box: { x: 0, y: 0, width: 4, height: 4 } });
		expect(await shrinkImageForCssVar(f.pup, SRC, 1_000_000)).toBeNull();
		// 连截图都不该发起
		expect(f.shots).toHaveLength(0);
	});

	it("连 <img> 都没有 / 量不到盒子 → null", async () => {
		expect(
			await shrinkImageForCssVar(fakePup({ sizes: [100], noElement: true }).pup, SRC, 1e6),
		).toBeNull();
		expect(
			await shrinkImageForCssVar(fakePup({ sizes: [100], box: null }).pup, SRC, 1e6),
		).toBeNull();
	});

	it("开了几个 page 就关几个 —— 失败那几档也得关", async () => {
		const f = fakePup({ sizes: [9_000_000] });
		await shrinkImageForCssVar(f.pup, SRC, 1000);
		expect(f.opened()).toBe(4);
		expect(f.closed()).toBe(4);
	});

	it("页面底色必须是透明的 —— 写死白底等于把 alpha 焊死", async () => {
		const f = fakePup({ sizes: [30_000] });
		await shrinkImageForCssVar(f.pup, SRC, 1_000_000);
		expect(f.html[0]).toContain("background:transparent");
		expect(f.html[0]).not.toMatch(/background:\s*#fff|background:\s*white/);
	});

	it("用 max-width 不用 width —— 比这一档还窄的图不许被放大", async () => {
		const f = fakePup({ sizes: [30_000] });
		await shrinkImageForCssVar(f.pup, SRC, 1_000_000);
		expect(f.html[0]).toContain("max-width:1200px");
		expect(f.html[0]).not.toMatch(/[^-]width:1200px/);
	});
});
