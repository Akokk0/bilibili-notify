import { describe, expect, it } from "vite-plus/test";
import type { CardStyleByKind } from "./common";
import { makeDefaultGlobalConfig } from "./globals";
import { resolveCardStyleForKind } from "./resolve";
import type { SubscriptionOverrides } from "./subscriptions";

const defaults = makeDefaultGlobalConfig().defaults;

describe("resolveCardStyleForKind", () => {
	it("falls back to the global base style when nothing is per-kind", () => {
		const s = resolveCardStyleForKind(defaults, null, "live");
		expect(s.backgroundImages).toEqual(defaults.cardStyle.backgroundImages);
		expect(s.cardColorStart).toBe(defaults.cardStyle.cardColorStart);
	});

	it("applies a global per-kind override only to that kind", () => {
		const byKind: CardStyleByKind = { live: { backgroundImages: ["g.png"] } };
		const d = { ...defaults, cardStyleByKind: byKind };
		expect(resolveCardStyleForKind(d, null, "live").backgroundImages).toEqual(["g.png"]);
		expect(resolveCardStyleForKind(d, null, "dynamic").backgroundImages).toEqual(
			defaults.cardStyle.backgroundImages,
		);
	});

	it("per-UP kind override beats the global kind override", () => {
		const d = { ...defaults, cardStyleByKind: { live: { backgroundImages: ["g.png"] } } };
		const ov: SubscriptionOverrides = {
			cardStyleByKind: { live: { backgroundImages: ["up.png"] } },
		};
		expect(resolveCardStyleForKind(d, ov, "live").backgroundImages).toEqual(["up.png"]);
	});

	it("per-UP base override beats the global per-kind override (precedence chain)", () => {
		const d = { ...defaults, cardStyleByKind: { live: { cardColorStart: "#globalkind" } } };
		const ov: SubscriptionOverrides = { cardStyle: { cardColorStart: "#upbase" } };
		expect(resolveCardStyleForKind(d, ov, "live").cardColorStart).toBe("#upbase");
	});
});
