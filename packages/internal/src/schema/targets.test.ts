import { describe, expect, it } from "vitest";
import { PushTargetSchema } from "./targets";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("PushTargetSchema (discriminated by platform)", () => {
	it("accepts a valid onebot target", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID,
			name: "ob",
			platform: "onebot",
			scope: "group",
			config: { baseUrl: "http://localhost:5700", groupId: "123" },
			enabled: true,
		});
		expect(r.success).toBe(true);
	});

	it("rejects onebot platform paired with webhook config (would silently pass under naked z.union)", () => {
		// `url` is required by webhook; onebot expects `baseUrl`. Under the old z.union schema
		// this could accidentally validate against the wrong branch.
		const r = PushTargetSchema.safeParse({
			id: UUID,
			name: "bad",
			platform: "onebot",
			scope: "group",
			config: { url: "https://example.com/hook" },
			enabled: true,
		});
		expect(r.success).toBe(false);
	});

	it("rejects webhook platform paired with onebot config", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID,
			name: "bad",
			platform: "webhook",
			scope: "group",
			config: { baseUrl: "http://localhost:5700" },
			enabled: true,
		});
		expect(r.success).toBe(false);
	});

	it("accepts a valid webhook target", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID,
			name: "wh",
			platform: "webhook",
			scope: "group",
			config: { url: "https://example.com/hook" },
			enabled: true,
		});
		expect(r.success).toBe(true);
	});

	it("accepts a valid web-dashboard target", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID,
			name: "dash",
			platform: "web-dashboard",
			scope: "channel",
			config: {},
			enabled: true,
		});
		expect(r.success).toBe(true);
	});

	it("rejects web-dashboard platform with onebot config", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID,
			name: "bad",
			platform: "web-dashboard",
			scope: "channel",
			config: { baseUrl: "http://localhost:5700" },
			enabled: true,
		});
		expect(r.success).toBe(false);
	});

	it("accepts a valid koishi-onebot target", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID,
			name: "onebot:111",
			platform: "koishi-onebot",
			scope: "group",
			config: { botPlatform: "onebot", channelId: "111" },
			enabled: true,
		});
		expect(r.success).toBe(true);
	});

	it("accepts a valid koishi-discord target", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID,
			name: "discord:111",
			platform: "koishi-discord",
			scope: "channel",
			config: { botPlatform: "discord", channelId: "111" },
			enabled: true,
		});
		expect(r.success).toBe(true);
	});

	it("rejects koishi-* target without botPlatform", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID,
			name: "bad",
			platform: "koishi-onebot",
			scope: "group",
			config: { channelId: "111" },
			enabled: true,
		});
		expect(r.success).toBe(false);
	});

	it("rejects unknown platform", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID,
			name: "bad",
			platform: "qq",
			scope: "group",
			config: { botPlatform: "qq", channelId: "111" },
			enabled: true,
		});
		expect(r.success).toBe(false);
	});
});
