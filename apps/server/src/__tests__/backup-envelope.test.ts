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
	return makeEmptySubscription({ id: uid, identity: { sourceKey: "bilibili", externalId: uid } });
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
 * 1.0 之前导出的备份(schemaVersion 1)一律拒收(ADR-0022 决策 6):0.x 的形状只有迁移器认得,要恢复就先装
 * 0.12 恢复、再升级到 1.0 走迁移。放过去的话,老备份里拓展订阅那一节在新版里没人认,B 站那节是空的时候
 * overwrite 会把现有订阅全删光,而且不报错。
 */
describe("backup envelope —— 1.0 之前的备份", () => {
	it("0.x 导出的(schemaVersion 1)→ unsupported,告诉主人先装 0.12 恢复再升级", () => {
		const env = buildBackup({ kind: "sanitized", createdAt: "x", sections: { subscriptions: [] } });
		const err = thrownBy(() => parseBackup(JSON.stringify({ ...env, schemaVersion: 1 })));
		if (!(err instanceof BackupRejectedError)) throw new Error("没有拒收");
		expect(err.code).toBe("unsupported");
		expect(err.message).toMatch(/0\.12/);
		expect(err.message).toMatch(/1\.0/);
	});

	it("历史保留换键以后导出的备份是版本 6(版本 5 是开发期的:设置里还是 app.historyRetentionDays,没有顶层 history 一节)", () => {
		expect(BACKUP_SCHEMA_VERSION).toBe(6);
	});

	it("版本 4 的备份(订阅里没有 routing.liveStreaming、设置里周期间隔还在 schedule 里)→ unsupported:不会被当成当前版本放进来", () => {
		const env = buildBackup({ kind: "sanitized", createdAt: "x", sections: { subscriptions: [] } });
		const err = thrownBy(() => parseBackup(JSON.stringify({ ...env, schemaVersion: 4 })));
		if (!(err instanceof BackupRejectedError)) throw new Error("没有拒收");
		expect(err.code).toBe("unsupported");
	});

	// 「先装 0.12 恢复」只对 0.x 导出的说得通:开发期的 2 / 3、以及以后 1.x 再抬版本时 1.0 导出的那些,装 0.12 恢复不了,
	// 照那句话做是条死路。原因要说实话:是哪个版本、比当前旧。
	it("比当前旧、但不是 0.x 导出的 → 不叫主人去装 0.12,说出两边的版本号", () => {
		const env = buildBackup({ kind: "sanitized", createdAt: "x", sections: { subscriptions: [] } });
		const err = thrownBy(() => parseBackup(JSON.stringify({ ...env, schemaVersion: 4 })));
		if (!(err instanceof BackupRejectedError)) throw new Error("没有拒收");
		expect(err.message).not.toMatch(/0\.12/);
		expect(err.message).toContain("（4）");
		expect(err.message).toContain(`（${BACKUP_SCHEMA_VERSION}）`);
	});
});
