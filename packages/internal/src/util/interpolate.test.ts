import { describe, expect, it, vi } from "vitest";
import { interpolate } from "./interpolate";

describe("interpolate()", () => {
	it("replaces flat variables", () => {
		expect(interpolate("Hello {name}!", { name: "world" })).toBe("Hello world!");
	});

	it("supports nested path lookup", () => {
		expect(interpolate("{user.name} ({user.age})", { user: { name: "ak", age: 18 } })).toBe(
			"ak (18)",
		);
	});

	it("keeps unknown variable raw and reports via onMissing", () => {
		const onMissing = vi.fn();
		const out = interpolate("{exists} / {missing}", { exists: "ok" }, onMissing);
		expect(out).toBe("ok / {missing}");
		expect(onMissing).toHaveBeenCalledWith("missing");
	});

	it("does not crash when path traverses non-object", () => {
		const out = interpolate("{a.b.c}", { a: 1 });
		expect(out).toBe("{a.b.c}");
	});
});
