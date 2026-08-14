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
