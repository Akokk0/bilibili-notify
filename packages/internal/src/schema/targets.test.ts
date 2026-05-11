import { describe, expect, it } from "vitest";
import { PushAdapterSchema, PushTargetSchema } from "./targets";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("PushAdapterSchema (discriminated by platform)", () => {
	it("accepts a valid onebot adapter", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "napcat-main",
			platform: "onebot",
			enabled: true,
			config: { baseUrl: "http://localhost:5700", accessToken: "secret" },
		});
		expect(r.success).toBe(true);
	});

	it("rejects an onebot adapter with webhook config", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "bad",
			platform: "onebot",
			enabled: true,
			config: { url: "https://example.com/hook" },
		});
		expect(r.success).toBe(false);
	});

	it("accepts a valid webhook adapter", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "wh1",
			platform: "webhook",
			enabled: true,
			config: { url: "https://example.com/hook" },
		});
		expect(r.success).toBe(true);
	});

	it("accepts a valid web-dashboard adapter", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "dashboard",
			platform: "web-dashboard",
			enabled: true,
			config: {},
		});
		expect(r.success).toBe(true);
	});

	it("accepts a valid koishi-bot adapter", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "onebot",
			platform: "koishi-bot",
			enabled: true,
			config: { botPlatform: "onebot" },
		});
		expect(r.success).toBe(true);
	});

	it("rejects koishi-bot adapter without botPlatform", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "bad",
			platform: "koishi-bot",
			enabled: true,
			config: {},
		});
		expect(r.success).toBe(false);
	});

	it("rejects unknown platform", () => {
		const r = PushAdapterSchema.safeParse({
			id: UUID_A,
			name: "bad",
			platform: "koishi-onebot",
			enabled: true,
			config: { botPlatform: "onebot" },
		});
		expect(r.success).toBe(false);
	});
});

describe("PushTargetSchema (discriminated by platform)", () => {
	it("accepts an onebot target", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "ob:111",
			adapterId: UUID_A,
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "111" },
		});
		expect(r.success).toBe(true);
	});

	it("accepts a webhook target with empty session", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "wh:1",
			adapterId: UUID_A,
			platform: "webhook",
			scope: "channel",
			enabled: true,
			session: {},
		});
		expect(r.success).toBe(true);
	});

	it("accepts a web-dashboard target with dashboardUser", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "dash",
			adapterId: UUID_A,
			platform: "web-dashboard",
			scope: "channel",
			enabled: true,
			session: { dashboardUser: "alice" },
		});
		expect(r.success).toBe(true);
	});

	it("accepts a koishi-bot target with channelId", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "ob:111",
			adapterId: UUID_A,
			platform: "koishi-bot",
			scope: "group",
			enabled: true,
			session: { channelId: "111" },
		});
		expect(r.success).toBe(true);
	});

	it("rejects onebot target missing adapterId", () => {
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "bad",
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "111" },
		});
		expect(r.success).toBe(false);
	});

	it("ignores extraneous session keys (zod is non-strict by default; only structural required keys matter)", () => {
		// Onebot session has only optional groupId/userId; extra keys are tolerated.
		const r = PushTargetSchema.safeParse({
			id: UUID_B,
			name: "ok",
			adapterId: UUID_A,
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "1", extraneous: "ignored" },
		});
		expect(r.success).toBe(true);
	});
});
