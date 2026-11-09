import { templateDefaultsFor } from "@bilibili-notify/internal/texts/builtin";
// @vitest-environment jsdom
/**
 * 规则页「上舰提示」(全局,㉓d):B 站会员体系 `guard` 的文案 —— 最上面一块是体系默认(文案 + 图片),下面舰长 / 提督 / 总督
 * 每档一块;某一档某一格没填时输入框的占位显示跟随的默认。补丁落在 `defaults.templates.membership.guard` 上:
 * 清空一格是显式 `null`(JSON Merge Patch 语义),一档两格都清空就把这一档整个 `null` 掉。
 */

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";

// These assertions describe the Chinese UI, independent of untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

import { GuardSection } from "../sections";
import { makeDefaults, makeSource } from "./fixtures";

afterEach(cleanup);

type Bundle = ReturnType<typeof makeDefaults>["templates"]["membership"][string];

const BUNDLE: Bundle = {
	enabled: true,
	default: { template: "{viewer} 来了 {name}", imageUrl: "https://img.test/default.png" },
	tiers: {
		captain: { template: "舰长专属 {viewer}", imageUrl: "https://img.test/captain.png" },
		governor: { template: "总督专属" },
	},
};

function renderSection(guard: Bundle | null = BUNDLE) {
	const defaults = makeDefaults();
	const templates: typeof defaults.templates = {
		...defaults.templates,
		membership: guard === null ? {} : { guard },
	};
	const onPatch = vi.fn();
	const view = render(
		<GuardSection
			programs={makeSource().descriptor.membershipPrograms}
			templates={templates}
			factory={templateDefaultsFor("zh-CN")}
			onPatch={onPatch}
		/>,
	);
	/** 一档那一块(按档 key 那枚小标签找)。 */
	const tierCard = (key: string): HTMLElement => {
		const chip = Array.from(view.container.querySelectorAll("code")).find(
			(c) => c.textContent === key,
		);
		const card = chip?.closest("div.rounded-lg") as HTMLElement | null;
		if (!card) throw new Error(`没找到 ${key} 那一块`);
		return card;
	};
	const defaultCard = (): HTMLElement => {
		const card = Array.from(view.container.querySelectorAll("div.rounded-lg")).find((el) =>
			el.textContent?.startsWith("体系默认"),
		);
		if (!card) throw new Error("没找到体系默认那一块");
		return card as HTMLElement;
	};
	const inputs = (card: HTMLElement) =>
		Array.from(card.querySelectorAll("input")) as HTMLInputElement[];
	return { onPatch, tierCard, defaultCard, inputs, ...view };
}

const guardPatch = (delta: object) => ({
	defaults: { templates: { membership: { guard: delta } } },
});

it.each([
	[
		"ja",
		"ご主人様、有効にすると会員通知の本文と画像をカスタマイズできますよ。無効にすると、取得元の既定内容を使いますね。",
		"ご主人様、いまは取得元が用意した会員通知の既定内容を使っていますよ。",
		"ご主人様、個別設定のないランクは制度の既定内容を使いますよ。画像が空欄なら、取得元が用意したそのランクのバッジ画像を使いますね。",
		"ご主人様、ランクはクリエイターが決めますよ。ここでは制度全体の既定テキストと画像だけを設定しますね。",
	],
	[
		"zh-TW",
		"主人，啟用後會使用自訂會員文案與圖片，關閉後則使用來源預設內容喔。",
		"主人，目前使用來源提供的預設會員內容喔。",
		"主人，未個別設定的等級會使用會員體系預設內容；圖片留空時，女僕會使用來源提供的該等級徽章喔。",
		"主人，等級由創作者自訂喔，女僕在這裡只設定會員體系的預設文案與圖片。",
	],
] as const)(
	"%s maid membership guidance preserves custom tiers, templates and source defaults",
	(locale, subtitle, inherited, fixed, custom) => {
		const defaults = makeDefaults();
		const bundle = {
			...BUNDLE,
			default: {
				template: "Original template 原文 {viewer}",
				imageUrl: "https://original.example/image.png",
			},
		};
		const onPatch = vi.fn();
		const view = render(
			<GuardSection
				programs={[
					{ id: "custom", name: "Original custom program 原文", tiers: "custom" },
					{
						id: "fixed",
						name: "Original fixed program 原文",
						tiers: [{ key: "gold", name: "Original tier 原文", rank: 4 }],
					},
					{ id: "inherited", name: "Original inherited program 原文", tiers: [] },
				]}
				templates={{
					...defaults.templates,
					membership: { custom: bundle, fixed: bundle, inherited: { ...bundle, enabled: false } },
				}}
				factory={templateDefaultsFor("zh-CN")}
				onPatch={onPatch}
			/>,
		);
		const inputs = view.getAllByDisplayValue("Original template 原文 {viewer}");
		for (const voice of ["maid", "plain"] as const) {
			act(() => i18n.set({ locale, voice }));
			if (voice === "maid") {
				expect(view.getAllByText(subtitle)).toHaveLength(3);
				expect(view.getByText(inherited, { exact: false })).toBeTruthy();
				expect(view.getByText(fixed)).toBeTruthy();
				expect(view.getByText(custom)).toBeTruthy();
			}
			expect(view.getAllByDisplayValue("Original template 原文 {viewer}")).toEqual(inputs);
			expect(view.container.textContent).toContain("Original tier 原文");
			expect(view.container.textContent).toContain("Original custom program 原文");
			expect(onPatch).not.toHaveBeenCalled();
		}
	},
);

describe("GuardSection · 开关", () => {
	it("custom 与空档只提供体系默认，自定义档说明由创作者决定", () => {
		const defaults = makeDefaults();
		const { container } = render(
			<GuardSection
				programs={[
					{ id: "custom", name: "Custom", tiers: "custom" },
					{ id: "empty", name: "Empty", tiers: [] },
				]}
				templates={{
					...defaults.templates,
					membership: { custom: { ...BUNDLE }, empty: { ...BUNDLE } },
				}}
				factory={templateDefaultsFor("zh-CN")}
				onPatch={vi.fn()}
			/>,
		);
		expect(container.querySelectorAll("input")).toHaveLength(4);
		expect(container.textContent).toContain("档位由创作者自定");
		expect(container.querySelectorAll('[data-code*=".tiers."]')).toHaveLength(0);
		expect(container.textContent).toContain("体系默认文案");
		expect(container.textContent).toContain("体系默认图片");
	});
	it("没开自定义:只有一句说明,没有输入框;点开关 → 补丁 enabled: true", () => {
		const { onPatch, container } = renderSection({ ...BUNDLE, enabled: false });
		expect(container.textContent).toContain("未启用");
		expect(container.querySelectorAll("input")).toHaveLength(0);
		fireEvent.click(container.querySelector("button") as HTMLButtonElement);
		expect(onPatch).toHaveBeenCalledWith(guardPatch({ enabled: true }));
	});

	it("开着:点开关 → 补丁 enabled: false", () => {
		const { onPatch, container } = renderSection();
		expect(container.textContent).toContain("已启用");
		fireEvent.click(container.querySelector("button") as HTMLButtonElement);
		expect(onPatch).toHaveBeenCalledWith(guardPatch({ enabled: false }));
	});

	it("配置里没有 B 站这个体系(手改删掉了):按出厂那份画 —— 关着,不抛", () => {
		const { container } = renderSection(null);
		expect(container.textContent).toContain("未启用");
	});
});

describe("GuardSection · 体系默认与三档", () => {
	it("四块,由上到下:体系默认、舰长、提督、总督;变量说明是 {viewer} / {name} / {tier}", () => {
		const { container } = renderSection();
		const blocks = Array.from(container.querySelectorAll("div.rounded-lg")).filter((el) =>
			/^(体系默认|舰长|提督|总督)/.test(el.textContent ?? ""),
		);
		expect(blocks.map((b) => (b.textContent ?? "").slice(0, 2))).toEqual([
			"体系",
			"舰长",
			"提督",
			"总督",
		]);
		const text = container.textContent ?? "";
		for (const v of ["{viewer}", "{name}", "{tier}"]) expect(text).toContain(v);
		for (const old of ["{uname}", "{mname}", "{guard}"]) expect(text).not.toContain(old);
	});

	it("体系默认那块显示默认文案与图片地址", () => {
		const { defaultCard, inputs } = renderSection();
		expect(inputs(defaultCard()).map((i) => i.value)).toEqual([
			"{viewer} 来了 {name}",
			"https://img.test/default.png",
		]);
	});

	it("配了的档显示自己的值;没配的格留空、占位显示跟随的默认(文案跟默认文案,图片跟默认图片)", () => {
		const { tierCard, inputs } = renderSection();
		const [captainText, captainImage] = inputs(tierCard("captain"));
		expect(captainText?.value).toBe("舰长专属 {viewer}");
		expect(captainImage?.value).toBe("https://img.test/captain.png");
		// 提督一格都没配
		const [commanderText, commanderImage] = inputs(tierCard("commander"));
		expect(commanderText?.value).toBe("");
		expect(commanderText?.placeholder).toBe("{viewer} 来了 {name}");
		expect(commanderImage?.value).toBe("");
		expect(commanderImage?.placeholder).toBe("https://img.test/default.png");
		// 总督只配了文案
		const [governorText, governorImage] = inputs(tierCard("governor"));
		expect(governorText?.value).toBe("总督专属");
		expect(governorImage?.value).toBe("");
		expect(governorImage?.placeholder).toBe("https://img.test/default.png");
	});

	it("默认也是空的:占位退成「跟随体系默认」/「留空 = 来源提供的徽章图」", () => {
		const { tierCard, inputs } = renderSection({
			enabled: true,
			default: { template: "", imageUrl: "" },
			tiers: {},
		});
		const [text, image] = inputs(tierCard("captain"));
		expect(text?.placeholder).toBe("跟随体系默认");
		expect(image?.placeholder).toBe("留空 = 来源提供的徽章图");
	});
});

describe("GuardSection · 落字", () => {
	it("改体系默认的文案 / 图片 → 补丁落在 guard.default 上,只带这一格", () => {
		const { onPatch, defaultCard, inputs } = renderSection();
		const [text, image] = inputs(defaultCard());
		fireEvent.change(text as HTMLInputElement, { target: { value: "新的默认" } });
		expect(onPatch).toHaveBeenLastCalledWith(guardPatch({ default: { template: "新的默认" } }));
		fireEvent.change(image as HTMLInputElement, { target: { value: "https://img.test/new.png" } });
		expect(onPatch).toHaveBeenLastCalledWith(
			guardPatch({ default: { imageUrl: "https://img.test/new.png" } }),
		);
	});

	it("给没配的档填一格 → 补丁落在 guard.tiers.<档 key> 上,只带这一格", () => {
		const { onPatch, tierCard, inputs } = renderSection();
		fireEvent.change(inputs(tierCard("commander"))[0] as HTMLInputElement, {
			target: { value: "提督来了" },
		});
		expect(onPatch).toHaveBeenLastCalledWith(
			guardPatch({ tiers: { commander: { template: "提督来了" } } }),
		);
	});

	it("清空一格(这一档还有别的格)→ 那一格显式 null,别的格不碰", () => {
		const { onPatch, tierCard, inputs } = renderSection();
		fireEvent.change(inputs(tierCard("captain"))[0] as HTMLInputElement, { target: { value: "" } });
		expect(onPatch).toHaveBeenLastCalledWith(
			guardPatch({ tiers: { captain: { template: null } } }),
		);
	});

	it("清空这一档唯一剩下的一格 → 整档显式 null(盘上不留空壳)", () => {
		const { onPatch, tierCard, inputs } = renderSection();
		fireEvent.change(inputs(tierCard("governor"))[0] as HTMLInputElement, {
			target: { value: "" },
		});
		expect(onPatch).toHaveBeenLastCalledWith(guardPatch({ tiers: { governor: null } }));
	});
});
