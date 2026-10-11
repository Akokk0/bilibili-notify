/**
 * `bindLogLevels`:核心设置里的日志等级怎么接到上下文上。
 * 当场推一次;`level` / `levels` 变了再推;别的核心设置变了不推(门不能写成整段 `logging` 比);摘掉之后不推。
 * 用真的 `NodeServiceContext` 捕获输出,看的是各日志器真实的放行,不是 spy 调用次数。
 */

import type { ConfigScope, GlobalConfig } from "@bilibili-notify/internal";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { LogEntry } from "../../ws/types.js";
import { bindLogLevels } from "../log-levels.js";
import { createNodeServiceContext } from "../service-context.js";

function setup(initial: (g: GlobalConfig) => void = () => {}) {
	const seen: LogEntry[] = [];
	const serviceCtx = createNodeServiceContext({
		name: "core",
		level: "error", // 开机早期等级:绑上之前一律只放 error
		pretty: false,
		onLog: (e) => seen.push(e),
	});
	let globals = makeDefaultGlobalConfig();
	initial(globals);
	const handlers = new Set<(scope: ConfigScope) => void>();
	const configStore = {
		getGlobals: () => globals,
		onChange: (fn: (scope: ConfigScope) => void) => {
			handlers.add(fn);
			return { dispose: () => void handlers.delete(fn) };
		},
	};
	const change = (mutate: (g: GlobalConfig) => void, scope: ConfigScope = "globals") => {
		const next = structuredClone(globals);
		mutate(next);
		globals = next;
		for (const fn of [...handlers]) fn(scope);
	};
	const apply = vi.spyOn(serviceCtx, "applyLogLevels");
	return { serviceCtx, configStore, seen, change, apply, handlers };
}

describe("bindLogLevels", () => {
	it("绑上当场推一次:设置里 core 那一格就是基础日志器的等级", () => {
		const { serviceCtx, configStore, seen } = setup((g) => {
			g.logging.level = "warn";
			g.logging.levels = { core: "debug" };
		});
		serviceCtx.logger.debug("before");
		expect(seen).toHaveLength(0);
		bindLogLevels({ serviceCtx, configStore });
		serviceCtx.logger.debug("after");
		expect(seen.map((e) => e.msg)).toEqual(["after"]);
	});

	it("level 或 levels 变了再推,日志器当场跟着变", () => {
		const { serviceCtx, configStore, seen, change } = setup();
		bindLogLevels({ serviceCtx, configStore });
		const bili = serviceCtx.forSubsystem("dynamic", "bilibili");
		bili.logger.debug("d0"); // 默认 info → 压
		change((g) => {
			g.logging.levels = { bilibili: "debug" };
		});
		bili.logger.debug("d1");
		change((g) => {
			g.logging.levels = {};
			g.logging.level = "warn";
		});
		bili.logger.info("i2");
		bili.logger.warn("w2");
		expect(seen.map((e) => e.msg)).toEqual(["d1", "w2"]);
	});

	it("别的核心设置变了不推(保留天数、内存自检开关;别的 scope 也不推)", () => {
		const { serviceCtx, configStore, change, apply } = setup();
		bindLogLevels({ serviceCtx, configStore });
		expect(apply).toHaveBeenCalledTimes(1);
		change((g) => {
			g.logging.retentionDays = 30;
		});
		change((g) => {
			g.logging.memoryLog.enabled = true;
		});
		change((g) => {
			g.logging.level = "debug";
		}, "targets");
		expect(apply).toHaveBeenCalledTimes(1);
		change((g) => {
			g.logging.level = "debug";
		});
		expect(apply).toHaveBeenCalledTimes(2);
	});

	it("摘掉之后不推", () => {
		const { serviceCtx, configStore, change, apply, handlers } = setup();
		const handle = bindLogLevels({ serviceCtx, configStore });
		handle.dispose();
		expect(handlers.size).toBe(0);
		change((g) => {
			g.logging.level = "debug";
		});
		expect(apply).toHaveBeenCalledTimes(1);
	});
});
