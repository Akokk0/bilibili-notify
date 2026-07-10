import { makeEmptySubscription, type Subscription } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import {
	BACKUP_FORMAT,
	BACKUP_SCHEMA_VERSION,
	buildBackup,
	parseBackup,
} from "../backup/envelope.js";

function makeSub(uid: string): Subscription {
	return makeEmptySubscription({ id: uid, uid });
}

describe("backup envelope", () => {
	it("builds a sanitized envelope and round-trips it through parse", () => {
		const subs = [makeSub("111"), makeSub("222")];
		const env = buildBackup({
			kind: "sanitized",
			createdAt: "2026-07-10T00:00:00.000Z",
			sections: { subscriptions: subs },
		});

		expect(env.format).toBe(BACKUP_FORMAT);
		expect(env.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
		expect(env.kind).toBe("sanitized");
		expect(env.createdAt).toBe("2026-07-10T00:00:00.000Z");

		const parsed = parseBackup(JSON.stringify(env));
		expect(parsed.kind).toBe("sanitized");
		expect(parsed.sections.subscriptions).toEqual(subs);
	});

	it("rejects a document that is not a backup file", () => {
		expect(() => parseBackup(JSON.stringify({ hello: "world" }))).toThrow();
	});

	it("rejects an unknown kind", () => {
		const env = buildBackup({ kind: "sanitized", createdAt: "x", sections: {} });
		const bad = JSON.stringify({ ...env, kind: "weird" });
		expect(() => parseBackup(bad)).toThrow();
	});

	it("rejects a schemaVersion newer than this build understands", () => {
		const env = buildBackup({ kind: "sanitized", createdAt: "x", sections: {} });
		const future = JSON.stringify({ ...env, schemaVersion: BACKUP_SCHEMA_VERSION + 1 });
		expect(() => parseBackup(future)).toThrow(/version/i);
	});

	it("accepts the current schemaVersion", () => {
		const env = buildBackup({ kind: "sanitized", createdAt: "x", sections: {} });
		expect(parseBackup(JSON.stringify(env)).schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
	});
});
