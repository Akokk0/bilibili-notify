/**
 * `createLogSink` 单一 fan-out 点:同一条 entry 原样 tee 给两路(WS ring + 磁盘 store)。
 *
 * 打码不在这里:entry 在日志调用入口已经打过码,「secret 进 → 三处出口都打码」的守卫
 * 在 runtime/__tests__/service-context-redaction.test.ts。
 * 复发点:漏掉某一路 / 两路拿到的不是同一条。
 */

import { describe, expect, it } from "vite-plus/test";
import type { LogChannel } from "../../ws/log-channel.js";
import type { LogEntry } from "../../ws/types.js";
import { createLogSink } from "../sink.js";
import type { LogStore } from "../store.js";

describe("createLogSink — 原样 tee 两路", () => {
	it("ring 与 store 各收到一次、内容一致", () => {
		const pushed: LogEntry[] = [];
		const ingested: LogEntry[] = [];
		const ring = { push: (e: LogEntry) => pushed.push(e) } as unknown as LogChannel;
		const store = { ingest: (e: LogEntry) => ingested.push(e) } as unknown as LogStore;

		const sink = createLogSink({ ring, store });
		const entry: LogEntry = {
			level: "info",
			msg: "已打过码 SESSDATA=***",
			args: [{ k: 1 }],
			ts: "2026-05-17T00:00:00.000Z",
			name: "dynamic",
		};
		sink(entry);

		expect(pushed).toEqual([entry]);
		expect(ingested).toEqual([entry]);
	});
});
