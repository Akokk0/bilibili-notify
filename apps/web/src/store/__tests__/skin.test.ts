/** skin store 纯 selector:effectiveSkin 优先级与文案槽读取。 */

import type { SkinManifest } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { effectiveSkin, skinTextOf } from "../skin";

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

describe("skinTextOf", () => {
	it("读当前生效皮肤的槽位;preview 优先;killSwitch 下 active 的文案不生效", () => {
		const active = skin("a", { headerTitle: "A 标题" });
		const preview = skin("p", { headerTitle: "P 标题" });

		expect(skinTextOf({ active, preview: null, killSwitch: false }, "headerTitle")).toBe("A 标题");
		expect(skinTextOf({ active, preview, killSwitch: false }, "headerTitle")).toBe("P 标题");
		expect(skinTextOf({ active, preview: null, killSwitch: true }, "headerTitle")).toBeNull();
		expect(skinTextOf({ active, preview: null, killSwitch: false }, "chatPlaceholder")).toBeNull();
		expect(
			skinTextOf({ active: null, preview: null, killSwitch: false }, "headerTitle"),
		).toBeNull();
	});
});

describe("effectiveSkin", () => {
	it("preview > killSwitch > active", () => {
		const active = skin("a");
		const preview = skin("p");
		expect(effectiveSkin({ active, preview, killSwitch: true })?.id).toBe("p");
		expect(effectiveSkin({ active, preview: null, killSwitch: true })).toBeNull();
		expect(effectiveSkin({ active, preview: null, killSwitch: false })?.id).toBe("a");
	});
});
