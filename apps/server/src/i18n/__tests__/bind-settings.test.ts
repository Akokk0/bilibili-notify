/**
 * `bindTextSettings`:核心设置里的语言与口吻怎么接到字典 store 上。
 * 当场推一次(缺的格按规则补);`locale` / `voice` 变了再推;别的 scope 不推;摘掉之后不推。
 * store 用真的 `createI18n` 搭的小样例,看的是 `state()` 真实的语言与口吻。
 */

import type { ConfigScope, GlobalSettings } from "@bilibili-notify/internal";
import { makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { createI18n, type Locale } from "@bilibili-notify/internal/i18n";
import { describe, expect, it } from "vite-plus/test";
import { bindTextSettings } from "../bind-settings.js";

function setup(initial: (g: GlobalSettings) => void = () => {}) {
	const i18n = createI18n<string, Locale>({
		dicts: {
			"zh-CN": { plain: { hi: "你好" }, maid: { hi: "主人好" } },
			"zh-TW": { plain: {} },
			en: { plain: { hi: "Hello" } },
			ja: { plain: {} },
		},
		fallback: "zh-CN",
		// 初值故意与规则默认不同:证明「当场推一次」真推了
		locale: "en",
		voice: "plain",
	});
	let globals = makeDefaultGlobalSettings();
	initial(globals);
	const handlers = new Set<(scope: ConfigScope) => void>();
	const configStore = {
		getGlobals: () => globals,
		onChange: (fn: (scope: ConfigScope) => void) => {
			handlers.add(fn);
			return { dispose: () => void handlers.delete(fn) };
		},
	};
	const change = (mutate: (g: GlobalSettings) => void, scope: ConfigScope = "globals") => {
		const next = structuredClone(globals);
		mutate(next);
		globals = next;
		for (const fn of [...handlers]) fn(scope);
	};
	return { i18n, configStore, change, handlers };
}

describe("bindTextSettings", () => {
	it("绑上当场推一次:设置里两格都缺 → 简中 + 女仆", () => {
		const { i18n, configStore } = setup();
		bindTextSettings({ set: (change) => i18n.set(change), configStore });
		expect(i18n.state().locale).toBe("zh-CN");
		expect(i18n.state().voice).toBe("maid");
		expect(i18n.t("hi")).toBe("主人好");
	});

	it("设置里写了的格原样推:locale ja、voice plain", () => {
		const { i18n, configStore } = setup((g) => {
			g.locale = "ja";
			g.voice = "plain";
		});
		bindTextSettings({ set: (change) => i18n.set(change), configStore });
		expect(i18n.state().locale).toBe("ja");
		expect(i18n.state().voice).toBe("plain");
	});

	it("locale 变了再推,voice 变了再推", () => {
		const { i18n, configStore, change } = setup();
		bindTextSettings({ set: (change) => i18n.set(change), configStore });
		change((g) => {
			g.locale = "en";
		});
		expect(i18n.state().locale).toBe("en");
		change((g) => {
			g.locale = "zh-CN";
			g.voice = "plain";
		});
		expect(i18n.state().locale).toBe("zh-CN");
		expect(i18n.state().voice).toBe("plain");
		expect(i18n.t("hi")).toBe("你好");
	});

	it("两格被删回缺失 → 回到规则默认", () => {
		const { i18n, configStore, change } = setup((g) => {
			g.locale = "en";
			g.voice = "plain";
		});
		bindTextSettings({ set: (change) => i18n.set(change), configStore });
		change((g) => {
			delete g.locale;
			delete g.voice;
		});
		expect(i18n.state().locale).toBe("zh-CN");
		expect(i18n.state().voice).toBe("maid");
	});

	it("别的 scope 变了不推", () => {
		const { i18n, configStore, change } = setup();
		bindTextSettings({ set: (change) => i18n.set(change), configStore });
		change((g) => {
			g.locale = "en";
		}, "targets");
		expect(i18n.state().locale).toBe("zh-CN");
	});

	it("摘掉之后不推", () => {
		const { i18n, configStore, change, handlers } = setup();
		const handle = bindTextSettings({ set: (change) => i18n.set(change), configStore });
		handle.dispose();
		expect(handlers.size).toBe(0);
		change((g) => {
			g.locale = "en";
		});
		expect(i18n.state().locale).toBe("zh-CN");
	});
});
