import type { LinkResolver } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { createLinkResolverRegistry } from "../registry.js";

const resolver = (label: string): LinkResolver => ({
	label,
	matches: () => false,
	resolve: async () => {
		throw new Error("不该被调到");
	},
});

describe("createLinkResolverRegistry", () => {
	it("同一个键登两次抛", () => {
		const registry = createLinkResolverRegistry();
		registry.register("acme", resolver("甲"));
		expect(() => registry.register("acme", resolver("乙"))).toThrow(
			'link resolver for key "acme" is already registered',
		);
	});

	it("撤掉之后同一个键可以重登", () => {
		const registry = createLinkResolverRegistry();
		const first = resolver("甲");
		const second = resolver("乙");
		registry.register("acme", first).dispose();
		expect(Array.from(registry.entries())).toEqual([]);
		registry.register("acme", second);
		expect(Array.from(registry.entries())).toEqual([["acme", second]]);
	});

	it("重登之后撤旧把手,不把新主人踢掉", () => {
		const registry = createLinkResolverRegistry();
		const old = registry.register("acme", resolver("甲"));
		old.dispose();
		const next = resolver("乙");
		registry.register("acme", next);
		old.dispose();
		expect(Array.from(registry.entries())).toEqual([["acme", next]]);
	});

	it("entries 按登记先后,撤了重登的排最后,带着键", () => {
		const registry = createLinkResolverRegistry();
		const a = resolver("甲");
		const b = resolver("乙");
		const c = resolver("丙");
		const handleA = registry.register("a", a);
		registry.register("b", b);
		registry.register("c", c);
		expect(Array.from(registry.entries())).toEqual([
			["a", a],
			["b", b],
			["c", c],
		]);
		handleA.dispose();
		registry.register("a", a);
		expect(Array.from(registry.entries())).toEqual([
			["b", b],
			["c", c],
			["a", a],
		]);
	});
});
