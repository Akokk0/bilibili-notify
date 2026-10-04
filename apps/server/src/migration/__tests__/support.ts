/**
 * 迁移器接缝的共用夹具:在一个临时的第 0 代根里摆 0.x 的文件 → `migrateZeroGeneration` 迁出一代 → 在新的一代
 * 上开一次配置仓。0.x 形状的兼容测试(最老的单文件 targets.json、连接 / 目标 v1、adapters.json、已撤下平台的
 * 存量……)都从这条接缝进,断言落在配置仓读出来的东西和新代 `config/` 里的文件上。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach } from "vite-plus/test";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { settingsSegment } from "../../bilibili/settings.js";
import { CONFIG_DIR, type ConfigStore, createConfigStore } from "../../config/store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { migrateZeroGeneration, type ZeroMigrationResult } from "../zero-generation.js";

export function makeServiceCtx(): ServiceContext {
	return {
		logger: silentLogger,
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose() {},
		signal: new AbortController().signal,
		track() {},
	};
}

export interface ZeroSandbox {
	/** 第 0 代的根(每条用例一份新的临时目录)。 */
	readonly zero: string;
	/** 新的一代(迁移往这里填)。 */
	readonly target: string;
	/** 往第 0 代摆一份 JSON 文件(`rel` 相对第 0 代根,如 `state/targets.json`)。 */
	placeZero(rel: string, body: unknown): Promise<void>;
	/** 往第 0 代摆一份原样的字节 —— 要逐字节比对的时候用。 */
	placeZeroText(rel: string, text: string): Promise<void>;
	/**
	 * 迁一代。`now` 是迁移里那次历史清扫按哪一刻算到期;缺省给一个很早的时刻({@link SANDBOX_NOW}),
	 * 用例里摆的哪一天都不算到期 —— 要测到期的用例自己传。
	 */
	migrate(options?: { now?: Date }): Promise<ZeroMigrationResult>;
	/** 在新的一代上开一次配置仓。 */
	load(): Promise<ConfigStore>;
	/** 迁一代,再在新的一代上开一次配置仓。 */
	migrateAndLoad(): Promise<ConfigStore>;
	/** 新代里 `config/<name>` 的路径。 */
	configPath(name: string): string;
	/** 读新代里 `config/<name>` 并当 JSON 解开。 */
	readConfig<T>(name: string): Promise<T>;
}

/**
 * 在调用它的 describe 里登记 beforeEach / afterEach:每条用例一份新的临时根,里面 `zero/` 是第 0 代、
 * `generation/` 是新的一代;用完删掉。返回的对象在用例里用。
 */
/** 沙箱里迁移缺省用的「此刻」:比任何用例摆的日子都早,所以缺省没有哪一天到期。 */
export const SANDBOX_NOW = new Date("2000-01-01T00:00:00.000Z");

export function useZeroSandbox(prefix: string): ZeroSandbox {
	let root = "";
	let zero = "";
	let target = "";

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), prefix));
		zero = join(root, "zero");
		target = join(root, "generation");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const configPath = (name: string) => join(target, ...CONFIG_DIR, name);
	const migrate = (options?: { now?: Date }) =>
		migrateZeroGeneration({
			zeroRoot: zero,
			targetDir: target,
			now: options?.now ?? SANDBOX_NOW,
		});
	const load = async () => {
		const store = createConfigStore({
			bootstrap: { server: { host: "127.0.0.1", port: 8787 }, dataDir: zero, logLevel: "info" },
			dataRoot: target,
			bus: createNodeMessageBus(),
			serviceCtx: makeServiceCtx(),
			// 与正式组装(`runtime/bootstrap.ts`)登记同样的集成设置。
			integrationSettings: [settingsSegment],
		});
		await store.load();
		return store;
	};
	const placeZeroText = async (rel: string, text: string) => {
		await mkdir(dirname(join(zero, rel)), { recursive: true });
		await writeFile(join(zero, rel), text);
	};

	return {
		get zero() {
			return zero;
		},
		get target() {
			return target;
		},
		placeZero: (rel, body) => placeZeroText(rel, JSON.stringify(body)),
		placeZeroText,
		migrate,
		load,
		async migrateAndLoad() {
			await migrate();
			return load();
		},
		configPath,
		async readConfig<T>(name: string) {
			return JSON.parse(await readFile(configPath(name), "utf8")) as T;
		},
	};
}
