import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Disposable } from "../../platform";
import { bindPackageText, packageText } from "..";

/**
 * 包里取字的口(ADR-0037 决策 6 下 10-28 的 🔗):两端在建 store 的文件里把自己的取字口交进来,
 * 包出字那一刻走它;没交过的(单测、打进拓展包的那份)按简体中文取,和今天写死的字一样。
 */
describe("packageText", () => {
	const bindings: Disposable[] = [];
	afterEach(() => {
		for (const binding of bindings.splice(0).reverse()) binding.dispose();
	});

	it("没绑过取字口时按简体中文取", () => {
		expect(packageText("internal.commands.prefixBlank")).toBe("前缀不能是纯空白");
	});

	it("绑了之后走绑进来的取字口,键与值原样交过去", () => {
		const seen: unknown[] = [];
		bindings.push(
			bindPackageText((key, values) => {
				seen.push([key, values]);
				return `译:${key}`;
			}),
		);
		expect(packageText("internal.commands.prefixBlank", { n: 1 })).toBe(
			"译:internal.commands.prefixBlank",
		);
		expect(seen).toEqual([["internal.commands.prefixBlank", { n: 1 }]]);
	});

	it("解绑后回到绑之前的那个口;再解绑一次不出错", () => {
		const outer = bindPackageText(() => "外");
		bindings.push(outer);
		const inner = bindPackageText(() => "内");
		expect(packageText("internal.commands.prefixBlank")).toBe("内");
		inner.dispose();
		expect(packageText("internal.commands.prefixBlank")).toBe("外");
		inner.dispose();
		expect(packageText("internal.commands.prefixBlank")).toBe("外");
		outer.dispose();
		expect(packageText("internal.commands.prefixBlank")).toBe("前缀不能是纯空白");
	});
});
