/** skin store 纯 selector:effectiveSkin 双槽按主题取用、优先级与文案槽读取。 */

import type { SkinManifest } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { type ActiveSkinSlots, EMPTY_SLOTS, effectiveSkin, skinTextOf } from "../skin";

function skin(name: string, texts?: SkinManifest["texts"]) {
	return {
		id: name,
		manifest: {
			schemaVersion: 1,
			name,
			modes: { light: {} },
			...(texts ? { texts } : {}),
		} as SkinManifest,
	};
}

function slots(partial: Partial<ActiveSkinSlots>): ActiveSkinSlots {
	return { ...EMPTY_SLOTS, ...partial };
}

describe("skinTextOf", () => {
	it("读当前主题槽皮肤的文案;preview 优先;killSwitch 下 active 的文案不生效", () => {
		const active = slots({ light: skin("a", { headerTitle: "A 标题" }) });
		const preview = skin("p", { headerTitle: "P 标题" });

		expect(skinTextOf({ active, preview: null, killSwitch: false }, "light", "headerTitle")).toBe(
			"A 标题",
		);
		expect(skinTextOf({ active, preview, killSwitch: false }, "light", "headerTitle")).toBe(
			"P 标题",
		);
		expect(
			skinTextOf({ active, preview: null, killSwitch: true }, "light", "headerTitle"),
		).toBeNull();
		expect(
			skinTextOf({ active, preview: null, killSwitch: false }, "light", "chatPlaceholder"),
		).toBeNull();
		// 暗色槽空:亮槽皮肤的文案在暗色下不生效
		expect(
			skinTextOf({ active, preview: null, killSwitch: false }, "dark", "headerTitle"),
		).toBeNull();
		expect(
			skinTextOf({ active: EMPTY_SLOTS, preview: null, killSwitch: false }, "light", "headerTitle"),
		).toBeNull();
	});
});

describe("effectiveSkin", () => {
	it("preview > killSwitch > 当前主题槽", () => {
		const active = slots({ light: skin("a"), dark: skin("d") });
		const preview = skin("p");
		expect(effectiveSkin({ active, preview, killSwitch: true }, "light")?.id).toBe("p");
		expect(effectiveSkin({ active, preview: null, killSwitch: true }, "light")).toBeNull();
		expect(effectiveSkin({ active, preview: null, killSwitch: false }, "light")?.id).toBe("a");
		expect(effectiveSkin({ active, preview: null, killSwitch: false }, "dark")?.id).toBe("d");
	});
});
