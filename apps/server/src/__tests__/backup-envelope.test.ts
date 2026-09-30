import { makeEmptySubscription, type Subscription } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import {
	BACKUP_FORMAT,
	BACKUP_SCHEMA_VERSION,
	buildBackup,
	parseBackup,
} from "../backup/envelope.js";
import { BackupRejectedError } from "../backup/rejected-error.js";

/** 抛出来的东西(没抛就是 undefined)。 */
function thrownBy(fn: () => unknown): unknown {
	try {
		fn();
	} catch (err) {
		return err;
	}
	return undefined;
}

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

	/** 拒收自带码、话是中文:路由靠码回给面板,不嗅文案。 */
	function rejection(json: string): { code: string; message: string } {
		const err = thrownBy(() => parseBackup(json));
		expect(err).toBeInstanceOf(BackupRejectedError);
		return err as { code: string; message: string };
	}

	it("rejects a document that is not a backup file → invalid", () => {
		const err = rejection(JSON.stringify({ hello: "world" }));
		expect(err.code).toBe("invalid");
		expect(err.message).toMatch(/不是.*备份文件/);
	});

	it("rejects an unknown kind → invalid", () => {
		const env = buildBackup({ kind: "sanitized", createdAt: "x", sections: {} });
		const err = rejection(JSON.stringify({ ...env, kind: "weird" }));
		expect(err.code).toBe("invalid");
		expect(err.message).toMatch(/类型/);
	});

	it("rejects a missing schemaVersion → invalid", () => {
		const env = buildBackup({ kind: "sanitized", createdAt: "x", sections: {} });
		const { schemaVersion: _dropped, ...rest } = env;
		const err = rejection(JSON.stringify(rest));
		expect(err.code).toBe("invalid");
		expect(err.message).toMatch(/schemaVersion/);
	});

	it("rejects a schemaVersion newer than this build understands → unsupported (not invalid)", () => {
		const env = buildBackup({ kind: "sanitized", createdAt: "x", sections: {} });
		const err = rejection(JSON.stringify({ ...env, schemaVersion: BACKUP_SCHEMA_VERSION + 1 }));
		expect(err.code).toBe("unsupported");
		expect(err.message).toContain(String(BACKUP_SCHEMA_VERSION + 1));
		expect(err.message).toMatch(/升级/);
	});

	it("accepts the current schemaVersion", () => {
		const env = buildBackup({ kind: "sanitized", createdAt: "x", sections: {} });
		expect(parseBackup(JSON.stringify(env)).schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
	});
});

/**
 * 连接那一段从前叫 `adapters`。老备份文件里只有老键,而 schemaVersion 没跟着涨 ——
 * 涨了会让老版本读不了新备份,而这次改动并不需要那样。所以判据只能是**键在不在**,
 * 折叠点定在 `validateBackup` 这一处:再往里走的每一步(计划、形状迁移、落盘)都只
 * 认一个名字,漏折的后果是整段连接被当成没导出、overwrite 时把主人的连接全删光。
 */
describe("backup envelope —— 老备份里的 adapters 段", () => {
	const legacyEnvelope = (sections: Record<string, unknown>) =>
		JSON.stringify({
			format: BACKUP_FORMAT,
			schemaVersion: BACKUP_SCHEMA_VERSION,
			kind: "sanitized",
			createdAt: "x",
			sections,
		});

	it("老键折进 connections,老键自己不留下", () => {
		const parsed = parseBackup(legacyEnvelope({ adapters: [{ id: "a1" }] }));
		expect(parsed.sections.connections).toEqual([{ id: "a1" }]);
		expect(parsed.sections).not.toHaveProperty("adapters");
	});

	it("两个键都在时以新的为准", () => {
		const parsed = parseBackup(
			legacyEnvelope({ adapters: [{ id: "old" }], connections: [{ id: "new" }] }),
		);
		expect(parsed.sections.connections).toEqual([{ id: "new" }]);
	});

	it("别的段一个不动", () => {
		const subs = [makeSub("111")];
		const parsed = parseBackup(legacyEnvelope({ adapters: [{ id: "a1" }], subscriptions: subs }));
		expect(parsed.sections.subscriptions).toEqual(subs);
	});

	it("没有老键的新备份原样通过", () => {
		const env = buildBackup({ kind: "sanitized", createdAt: "x", sections: { connections: [] } });
		expect(parseBackup(JSON.stringify(env)).sections.connections).toEqual([]);
	});
});
