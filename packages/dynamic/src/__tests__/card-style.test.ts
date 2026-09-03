import { describe, expect, it } from "vite-plus/test";
import { resolveDynamicColorOptions } from "../card-style";

/**
 * 动态卡 colorOptions 的解析规则从 DynamicEngine 里提出来了 —— 独立端的链接卡也要
 * 按同一条规则出图。这里只钉纯函数;引擎那侧的行为仍由 dynamic-engine.test 钉着。
 */
describe("resolveDynamicColorOptions", () => {
	const rotating = () => {
		const cursors: Record<string, number> = {};
		return (key: string, images: string[]) => {
			const i = cursors[key] ?? 0;
			cursors[key] = i + 1;
			return images[i % images.length];
		};
	};

	it("样式自带多图 → 每调一次轮一张,并强制 enable", () => {
		const pick = rotating();
		const picks = [0, 1, 2].map(
			() =>
				resolveDynamicColorOptions({
					style: { enable: true, backgroundImages: ["a", "b"] },
					defaultBackgroundImages: undefined,
					pick,
					scopeKey: "global:dynamic",
				})?.backgroundImage,
		);
		expect(picks).toEqual(["a", "b", "a"]);
	});

	it("样式没图、全局图廊多图 → 按全局图廊轮;enable:false 也照轮", () => {
		const pick = rotating();
		const out = resolveDynamicColorOptions({
			style: { enable: false },
			defaultBackgroundImages: ["x", "y"],
			pick,
			scopeKey: "k",
		});
		expect(out).toMatchObject({ enable: true, backgroundImage: "x" });
	});

	it("没什么可轮(单图 / 没选择器)→ enable 的原样给,不 enable 的 undefined", () => {
		expect(
			resolveDynamicColorOptions({
				style: { enable: true, backgroundImage: "solo", backgroundImages: ["solo"] },
				defaultBackgroundImages: ["x", "y"],
				pick: () => "IGNORED",
				scopeKey: "k",
			}),
		).toEqual({ enable: true, backgroundImage: "solo", backgroundImages: ["solo"] });
		expect(
			resolveDynamicColorOptions({
				style: { enable: false },
				defaultBackgroundImages: ["x", "y"],
				pick: undefined,
				scopeKey: "k",
			}),
		).toBeUndefined();
	});
});
