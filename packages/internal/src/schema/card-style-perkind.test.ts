import { describe, expect, it } from "vite-plus/test";
import type { CardStyleByKind } from "./common";
import { makeDefaultGlobalConfig } from "./globals";
import { resolveCardStyleForKind } from "./resolve";
import type { SubscriptionOverrides } from "./subscriptions";

const defaults = makeDefaultGlobalConfig().defaults;

describe("resolveCardStyleForKind", () => {
	it("falls back to the global base style when nothing is per-kind", () => {
		const s = resolveCardStyleForKind(defaults, null, "live");
		expect(s.liveCoverImages).toEqual(defaults.cardStyle.liveCoverImages);
		expect(s.font).toBe(defaults.cardStyle.font);
	});

	it("applies a global per-kind override only to that kind", () => {
		const byKind: CardStyleByKind = { live: { liveCoverImages: ["g.png"] } };
		const d = { ...defaults, cardStyleByKind: byKind };
		expect(resolveCardStyleForKind(d, null, "live").liveCoverImages).toEqual(["g.png"]);
		expect(resolveCardStyleForKind(d, null, "dynamic").liveCoverImages).toEqual(
			defaults.cardStyle.liveCoverImages,
		);
	});

	it("per-UP kind override beats the global kind override", () => {
		const d = { ...defaults, cardStyleByKind: { live: { liveCoverImages: ["g.png"] } } };
		const ov: SubscriptionOverrides = {
			cardStyleByKind: { live: { liveCoverImages: ["up.png"] } },
		};
		expect(resolveCardStyleForKind(d, ov, "live").liveCoverImages).toEqual(["up.png"]);
	});

	it("per-UP base override beats the global per-kind override (precedence chain)", () => {
		const d = { ...defaults, cardStyleByKind: { live: { font: "GlobalKind Sans" } } };
		const ov: SubscriptionOverrides = { cardStyle: { font: "UpBase Sans" } };
		expect(resolveCardStyleForKind(d, ov, "live").font).toBe("UpBase Sans");
	});
});
