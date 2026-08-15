import { describe, expect, it } from "vitest";
import { parseSkinManifest } from "../schema";

/** 最小合法 manifest:骨架三件套 schemaVersion + name + 至少一个 mode。 */
function minimal(): Record<string, unknown> {
	return { schemaVersion: 1, name: "测试皮肤", modes: { light: {} } };
}

describe("parseSkinManifest / 骨架校验", () => {
	it("最小合法 manifest → ok,无告警", () => {
		const r = parseSkinManifest(minimal());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.skin.name).toBe("测试皮肤");
		expect(r.warnings).toEqual([]);
	});

	it("非对象输入(字符串/null/数组)→ 拒绝", () => {
		for (const bad of ["{}", null, [], 42]) {
			const r = parseSkinManifest(bad);
			expect(r.ok).toBe(false);
		}
	});

	it("缺 name / 空 name / 超 50 字 name → 拒绝", () => {
		for (const name of [undefined, "", "皮".repeat(51)]) {
			const r = parseSkinManifest({ ...minimal(), name });
			expect(r.ok).toBe(false);
		}
	});

	it("schemaVersion 不是 1 → 拒绝,错误信息提示版本不兼容", () => {
		const r = parseSkinManifest({ ...minimal(), schemaVersion: 2 });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toMatch(/schemaVersion|版本/);
	});

	it("modes 缺失或空对象 → 拒绝(皮肤至少要给一套模式)", () => {
		for (const modes of [undefined, {}]) {
			const r = parseSkinManifest({ ...minimal(), modes });
			expect(r.ok).toBe(false);
		}
	});

	it("light + dark 双套 → ok,两套都保留", () => {
		const r = parseSkinManifest({ ...minimal(), modes: { light: {}, dark: {} } });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.skin.modes.light).toBeDefined();
		expect(r.skin.modes.dark).toBeDefined();
	});
});

describe("parseSkinManifest / colors 值校验(注入面)", () => {
	function withColors(colors: Record<string, unknown>) {
		return { schemaVersion: 1, name: "t", modes: { light: { colors } } };
	}

	it("合法颜色语法全放行:hex/rgb/hsl/oklch/transparent", () => {
		const r = parseSkinManifest(
			withColors({
				accent: "#fb7299",
				accentSoft: "#fde1ea80",
				surface: "rgb(255 255 255)",
				border: "rgba(0, 0, 0, 0.35)",
				textPrimary: "hsl(220 30% 10% / 0.9)",
				success: "oklch(0.7 0.15 160)",
				overlay: "transparent",
			}),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.skin.modes.light?.colors?.accent).toBe("#fb7299");
	});

	it("url() / 分号 / 大括号 / var() / expression → 拒绝且错误带字段路径", () => {
		const bads = [
			"url(https://evil.example/p.png)",
			"#fff; background: url(x)",
			"red } body { display: none",
			"var(--color-bn-pink)",
			"expression(alert(1))",
		];
		for (const bad of bads) {
			const r = parseSkinManifest(withColors({ accent: bad }));
			expect(r.ok).toBe(false);
			if (r.ok) continue;
			expect(r.errors.join()).toContain("accent");
		}
	});

	it("colors 里的渐变 → 拒绝(渐变只属于 page.background)", () => {
		const r = parseSkinManifest(withColors({ surface: "linear-gradient(#fff, #000)" }));
		expect(r.ok).toBe(false);
	});

	it("未知 colors 键 → 忽略 + 告警(向前兼容),已知键照常保留", () => {
		const r = parseSkinManifest(withColors({ accent: "#fb7299", futureKey: "#000" }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.skin.modes.light?.colors?.accent).toBe("#fb7299");
		expect((r.skin.modes.light?.colors as Record<string, unknown>).futureKey).toBeUndefined();
		expect(r.warnings.join()).toContain("futureKey");
	});

	it("非字符串颜色值 → 拒绝", () => {
		const r = parseSkinManifest(withColors({ accent: 42 }));
		expect(r.ok).toBe(false);
	});
});

describe("parseSkinManifest / page.background(允许渐变,仍禁注入)", () => {
	function withPage(background: unknown) {
		return { schemaVersion: 1, name: "t", modes: { light: { page: { background } } } };
	}

	it("纯色与 linear/radial 渐变 → ok", () => {
		for (const v of [
			"#fef0f4",
			"linear-gradient(135deg, #fef0f4 0%, #f0f7fd 50%, #faf2ff 100%)",
			"radial-gradient(circle at 12% 12%, rgba(251, 114, 153, 0.22), transparent 28%)",
		]) {
			const r = parseSkinManifest(withPage(v));
			expect(r.ok).toBe(true);
		}
	});

	it("渐变里藏 url() 或注释符 → 拒绝", () => {
		for (const v of [
			"linear-gradient(#fff, #000), url(https://evil.example/x.png)",
			"linear-gradient(#fff /* sneak */, #000)",
		]) {
			const r = parseSkinManifest(withPage(v));
			expect(r.ok).toBe(false);
		}
	});
});

describe("parseSkinManifest / wallpaper", () => {
	function withWallpaper(wallpaper: Record<string, unknown>) {
		return { schemaVersion: 1, name: "t", modes: { dark: { wallpaper } } };
	}

	it("完整合法 wallpaper → ok", () => {
		const r = parseSkinManifest(
			withWallpaper({
				image: "assets/bg.webp",
				fit: "cover",
				position: "center top",
				overlay: 0.35,
			}),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.skin.modes.dark?.wallpaper?.image).toBe("assets/bg.webp");
	});

	it("image 不在 assets/ 下、带路径穿越或非白名单扩展名 → 拒绝", () => {
		for (const image of [
			"https://evil.example/x.png",
			"assets/../secrets.txt",
			"assets/x.svg",
			"/etc/passwd",
			"bg.webp",
		]) {
			const r = parseSkinManifest(withWallpaper({ image }));
			expect(r.ok).toBe(false);
		}
	});

	it("blur 0~40 收下;越界或非数字 → 拒绝", () => {
		const ok = parseSkinManifest(withWallpaper({ image: "assets/a.png", blur: 12 }));
		expect(ok.ok).toBe(true);
		if (!ok.ok) return;
		expect(ok.skin.modes.dark?.wallpaper?.blur).toBe(12);
		expect(parseSkinManifest(withWallpaper({ image: "assets/a.png", blur: 41 })).ok).toBe(false);
		expect(parseSkinManifest(withWallpaper({ image: "assets/a.png", blur: -1 })).ok).toBe(false);
		expect(parseSkinManifest(withWallpaper({ image: "assets/a.png", blur: "12" })).ok).toBe(false);
	});

	it("overlay 超出 0~0.8 或 fit 非枚举 → 拒绝", () => {
		expect(parseSkinManifest(withWallpaper({ image: "assets/a.png", overlay: 0.9 })).ok).toBe(
			false,
		);
		expect(parseSkinManifest(withWallpaper({ image: "assets/a.png", overlay: -1 })).ok).toBe(false);
		expect(parseSkinManifest(withWallpaper({ image: "assets/a.png", fit: "stretch" })).ok).toBe(
			false,
		);
	});

	it("position 只收关键词/百分比字符,注入形状 → 拒绝", () => {
		const r = parseSkinManifest(
			withWallpaper({ image: "assets/a.png", position: "center; background:url(x)" }),
		);
		expect(r.ok).toBe(false);
	});
});

describe("parseSkinManifest / glass · fonts · radius", () => {
	it("glass 合法值 → ok;blur 超 0~40 → 拒绝", () => {
		const ok = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			modes: {
				light: {
					glass: {
						background: "rgba(255, 255, 255, 0.6)",
						border: "rgba(255, 255, 255, 0.4)",
						strongBackground: "rgba(255, 255, 255, 0.9)",
						blur: 20,
						strongBlur: 24,
					},
				},
			},
		});
		expect(ok.ok).toBe(true);
		const bad = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			modes: { light: { glass: { blur: 41 } } },
		});
		expect(bad.ok).toBe(false);
	});

	it("fonts.body 字体名白名单字符 → ok;含注入字符 → 拒绝", () => {
		const ok = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			modes: { light: { fonts: { body: ["LXGW WenKai", "Noto Sans SC", "霞鹜文楷"] } } },
		});
		expect(ok.ok).toBe(true);
		const bad = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			modes: { light: { fonts: { body: ['x"; src: url(evil)'] } } },
		});
		expect(bad.ok).toBe(false);
	});

	it("radius card 0~32 / pill 0~999 → ok;越界 → 拒绝", () => {
		const ok = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			modes: { light: { radius: { card: 20, pill: 999 } } },
		});
		expect(ok.ok).toBe(true);
		const bad = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			modes: { light: { radius: { card: 40 } } },
		});
		expect(bad.ok).toBe(false);
	});
});

describe("parseSkinManifest / 未知字段告警(向前兼容)", () => {
	it("manifest 顶层与 mode 顶层的未知键 → 忽略 + 告警,不拒绝", () => {
		const r = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			futureTop: true,
			modes: { light: { colors: { accent: "#fff" }, futureSection: { x: 1 } } },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings.join()).toContain("futureTop");
		expect(r.warnings.join()).toContain("futureSection");
		expect(r.skin.modes.light?.colors?.accent).toBe("#fff");
	});
});

describe("parseSkinManifest / decorations(贴纸装饰层)", () => {
	function withDecorations(decorations: unknown) {
		return { schemaVersion: 1, name: "t", modes: { dark: { decorations } } };
	}

	it("合法贴纸数组 → ok,默认值补齐(anchor=bottom-right,width=200,opacity=1)", () => {
		const r = parseSkinManifest(
			withDecorations([
				{ image: "assets/chara.png", anchor: "bottom-right", width: 260, opacity: 0.9 },
				{ image: "assets/star.webp" },
			]),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const d = r.skin.modes.dark?.decorations;
		expect(d).toHaveLength(2);
		expect(d?.[0]).toMatchObject({ image: "assets/chara.png", width: 260, opacity: 0.9 });
		expect(d?.[1]).toMatchObject({
			image: "assets/star.webp",
			anchor: "bottom-right",
			width: 200,
			opacity: 1,
		});
	});

	it("超过 6 张 / image 非包内资产 / anchor 非法 / width·opacity·offset 越界 → 拒绝", () => {
		const many = Array.from({ length: 7 }, (_, i) => ({ image: `assets/a${i}.png` }));
		expect(parseSkinManifest(withDecorations(many)).ok).toBe(false);
		expect(parseSkinManifest(withDecorations([{ image: "https://evil.example/x.png" }])).ok).toBe(
			false,
		);
		expect(
			parseSkinManifest(withDecorations([{ image: "assets/a.png", anchor: "middle-ish" }])).ok,
		).toBe(false);
		expect(parseSkinManifest(withDecorations([{ image: "assets/a.png", width: 1000 }])).ok).toBe(
			false,
		);
		expect(parseSkinManifest(withDecorations([{ image: "assets/a.png", opacity: 1.5 }])).ok).toBe(
			false,
		);
		expect(parseSkinManifest(withDecorations([{ image: "assets/a.png", offsetX: -500 }])).ok).toBe(
			false,
		);
	});
});

describe("parseSkinManifest / shadows(辉光阴影)", () => {
	it("合法阴影语法 → ok;藏 url()/分号 → 拒绝", () => {
		const ok = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			modes: {
				dark: {
					shadows: {
						card: "0 10px 30px rgba(57, 197, 187, 0.25)",
						elev: "0 18px 50px rgba(57, 197, 187, 0.4), 0 0 0 1px #39c5bb",
					},
				},
			},
		});
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(ok.skin.modes.dark?.shadows?.card).toContain("rgba(57, 197, 187, 0.25)");
		}
		const bad = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			modes: { dark: { shadows: { card: "0 0 4px red; background: url(x)" } } },
		});
		expect(bad.ok).toBe(false);
	});
});

describe("parseSkinManifest / banner 已下线", () => {
	it("存量皮肤里的 banner → 按未知字段忽略并告警,优雅降级", () => {
		const r = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			modes: { light: { banner: { image: "assets/hero.png" } } },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect((r.skin.modes.light as Record<string, unknown>).banner).toBeUndefined();
		expect(r.warnings.some((w) => w.includes("banner"))).toBe(true);
	});
});

describe("parseSkinManifest / texts(主题文案槽,manifest 顶层)", () => {
	it("已知槽位收下,未知槽位告警忽略,超长拒绝", () => {
		const r = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			texts: {
				headerTitle: "Miku Codex · 电子歌姬值班室",
				chatPlaceholder: "和 Miku 酱说点什么吧~",
				futureSlot: "x",
			},
			modes: { light: {} },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.skin.texts?.headerTitle).toBe("Miku Codex · 电子歌姬值班室");
		expect(r.skin.texts?.chatPlaceholder).toBe("和 Miku 酱说点什么吧~");
		expect((r.skin.texts as Record<string, unknown>).futureSlot).toBeUndefined();
		expect(r.warnings.join()).toContain("futureSlot");

		const long = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			texts: { headerTitle: "长".repeat(61) },
			modes: { light: {} },
		});
		expect(long.ok).toBe(false);
	});
});

describe("parseSkinManifest / 自定义 CSS(清洗层接入)", () => {
	it("mode.css 与顶层 css 都过清洗,存的是清洗后的产物,warnings 透传", () => {
		const r = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			css: `[data-bn="glass"] { border-width: 2px; } div { color: red; }`,
			modes: {
				light: { css: `[data-bn="btn"] { transform: rotate(-1deg); display: none; }` },
			},
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.skin.css).toContain("border-width:2px");
		expect(r.skin.css).not.toContain("color");
		expect(r.skin.modes.light?.css).toContain("transform:");
		expect(r.skin.modes.light?.css).not.toContain("display");
		// div 整条 + display 一条 = 两条告警
		expect(r.warnings).toHaveLength(2);
	});

	it("清洗后为空串 → css 字段整个消失(与没写同构)", () => {
		const r = parseSkinManifest({
			schemaVersion: 1,
			name: "t",
			css: "div { color: red; }",
			modes: { light: { css: "  " } },
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.skin.css).toBeUndefined();
		expect(r.skin.modes.light?.css).toBeUndefined();
	});

	it("css 不是字符串 / 超 64KB → 拒绝", () => {
		expect(
			parseSkinManifest({ schemaVersion: 1, name: "t", css: 1, modes: { light: {} } }).ok,
		).toBe(false);
		const big = `[data-bn="glass"]{border-width:1px}`.repeat(3000);
		expect(
			parseSkinManifest({ schemaVersion: 1, name: "t", css: big, modes: { light: {} } }).ok,
		).toBe(false);
	});
});

describe("parseSkinManifest / effects(动效预设)", () => {
	function withEffects(effects: unknown) {
		return { schemaVersion: 1, name: "t", modes: { light: { effects } } };
	}

	it("三道全开的合法 effects → 原样收下(density/color 校验过)", () => {
		const r = parseSkinManifest(
			withEffects({
				particles: { kind: "sakura", density: 0.8, color: "#ffb7c5" },
				glassShine: { color: "#39c5bb" },
				bokeh: { colors: ["#fb7299", "rgba(0,174,236,0.5)"] },
			}),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const fx = r.skin.modes.light?.effects;
		expect(fx?.particles).toEqual({ kind: "sakura", density: 0.8, color: "#ffb7c5" });
		expect(fx?.glassShine).toEqual({ color: "#39c5bb" });
		expect(fx?.bokeh?.colors).toHaveLength(2);
	});

	it("backgroundFlow 已下线:按未知字段忽略并告警,存量皮肤优雅降级", () => {
		const r = parseSkinManifest(withEffects({ backgroundFlow: true, glassShine: {} }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.skin.modes.light?.effects).toEqual({ glassShine: {} });
		expect(r.warnings.some((w) => w.includes("backgroundFlow"))).toBe(true);
	});

	it("非法值逐项拒绝:未知 kind / density 越界 / bokeh 超 4 团 / 颜色带 url(", () => {
		expect(parseSkinManifest(withEffects({ particles: { kind: "rain" } })).ok).toBe(false);
		expect(parseSkinManifest(withEffects({ particles: { kind: "snow", density: 2 } })).ok).toBe(
			false,
		);
		expect(
			parseSkinManifest(withEffects({ bokeh: { colors: ["#1", "#2", "#3", "#4", "#5"] } })).ok,
		).toBe(false);
		expect(parseSkinManifest(withEffects({ glassShine: { color: "url(evil)" } })).ok).toBe(false);
	});

	it("空 effects 对象 → 字段消失;未知子键告警忽略", () => {
		const r = parseSkinManifest(withEffects({ future: 1 }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.skin.modes.light?.effects).toBeUndefined();
		expect(r.warnings.join()).toContain("future");
	});
});
