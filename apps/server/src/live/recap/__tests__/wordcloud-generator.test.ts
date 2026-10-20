import type { ImageRenderer } from "@bilibili-notify/image";
import type { Logger } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { WordcloudGenerator } from "../wordcloud-generator.js";

const logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
} as unknown as Logger;
const words = Array.from(
	{ length: 60 },
	(_, index) => [`w${index}`, 60 - index] as [string, number],
);

function renderer() {
	const generateWordCloudImg = vi.fn(async () => Buffer.from("wc"));
	return { renderer: { generateWordCloudImg } as unknown as ImageRenderer, generateWordCloudImg };
}

describe("WordcloudGenerator — getImageRenderer provider 模式", () => {
	it("provider 返回 null → generate 返回 undefined,不调渲染器", async () => {
		const wc = new WordcloudGenerator({ getImageRenderer: () => null, logger });
		expect(await wc.generate(words, "Master")).toBeUndefined();
	});

	it("provider 现取 → 中途替换实例,下次 generate 走新实例", async () => {
		let current: ImageRenderer | null = null;
		const wc = new WordcloudGenerator({ getImageRenderer: () => current, logger });
		expect(await wc.generate(words, "M1")).toBeUndefined();
		const made = renderer();
		current = made.renderer;
		expect(await wc.generate(words, "M2")).toEqual(Buffer.from("wc"));
		expect(made.generateWordCloudImg).toHaveBeenCalledTimes(1);
		current = null;
		expect(await wc.generate(words, "M3")).toBeUndefined();
		expect(made.generateWordCloudImg).toHaveBeenCalledTimes(1);
	});

	it("皮肤 id 透传给 generateWordCloudImg", async () => {
		const made = renderer();
		const wc = new WordcloudGenerator({ getImageRenderer: () => made.renderer, logger });
		await wc.generate(words, "M", undefined, "k6eee-cafed00d");
		const calls = made.generateWordCloudImg.mock.calls as unknown as unknown[][];
		expect(calls[0]?.[3]).toEqual({
			cardSkin: "k6eee-cafed00d",
		});
	});

	it("per-UP 旋钮覆盖随皮肤 id 透传给 generateWordCloudImg", async () => {
		const made = renderer();
		const wc = new WordcloudGenerator({ getImageRenderer: () => made.renderer, logger });
		const cardSkinKnobs = { "k6eee-cafed00d": { accent: "#aaaaaa" } };
		await wc.generate(words, "M", undefined, "k6eee-cafed00d", cardSkinKnobs);
		const calls = made.generateWordCloudImg.mock.calls as unknown as unknown[][];
		expect(calls[0]?.[3]).toEqual({
			cardSkin: "k6eee-cafed00d",
			cardSkinKnobs,
		});
	});

	it("isImageEnabled() 返回 false → 即便 provider 有渲染器也跳过", async () => {
		const made = renderer();
		const wc = new WordcloudGenerator({
			getImageRenderer: () => made.renderer,
			isImageEnabled: () => false,
			logger,
		});
		expect(await wc.generate(words, "M")).toBeUndefined();
		expect(made.generateWordCloudImg).not.toHaveBeenCalled();
	});
});
