import {
	type Disposable,
	fail,
	issuesFromZod,
	type Logger,
	ok,
	type Result,
	type SettingsReader,
} from "@bilibili-notify/internal";
import type { ZodType } from "zod";
import type { ConfigStore } from "../config/store.js";
import { errorMessageOf } from "../util/error-message.js";

export interface CreateSettingsReaderOptions<T> {
	schema: ZodType<T>;
	/** 盘上那一份的 JSON 值;整个文件读不懂回失败。 */
	read(): Result<{ settings: unknown }>;
	/** 「集成的设置可能变了」;回的把手由调用方收。 */
	onChanged(fn: () => void): Disposable;
	logger: Logger;
}

/**
 * 给一个集成造「读自己设置」的把手。`get()` 每次现读现判、永不抛。
 *
 * 宿主只说「集成的设置可能变了」(别的格、别的集成动了也会说),所以把手自己拿上一次读到的结果比一遍,
 * 真变了才叫订阅者。比较用的游标**只有一个**、住在把手里:每个订阅者各存一份、又去推同一个公共变量的话,
 * 第一个订阅者推进游标之后第二个永远收不到。
 */
export function createSettingsReader<T>(opts: CreateSettingsReaderOptions<T>): {
	reader: SettingsReader<T>;
	dispose(): void;
} {
	const { schema, logger } = opts;

	const get = (): Result<{ settings: T }> => {
		const raw = opts.read();
		if (!raw.ok) return raw;
		const parsed = schema.safeParse(raw.settings);
		if (parsed.success) return ok({ settings: parsed.data });
		const issues = issuesFromZod(parsed.error);
		return fail("invalid", issues[0]?.message ?? "设置读不懂", { issues });
	};

	/** 成功比值、失败比原因:原因变了读的人要据此换问题文案,所以也算「变了」。 */
	const fingerprint = (result: Result<{ settings: T }>): string =>
		JSON.stringify(
			result.ok
				? ["settings", result.settings]
				: ["failure", result.code, result.message, result.issues],
		);

	const subscribers = new Set<() => void>();
	let cursor = fingerprint(get());
	let disposed = false;

	const watch = opts.onChanged(() => {
		if (disposed) return;
		const next = fingerprint(get());
		if (next === cursor) return;
		cursor = next;
		for (const fn of [...subscribers]) {
			// 宿主的通知口是普通发射器:一个订阅者抛了会跳过后面的、还会冲回发射循环,每个单独接。
			try {
				fn();
			} catch (err) {
				logger.error(`[settings] 设置变化的回调抛错(忽略): ${errorMessageOf(err)}`);
			}
		}
	});

	return {
		reader: {
			get,
			onChange(fn) {
				if (disposed) return { dispose() {} };
				subscribers.add(fn);
				return {
					dispose() {
						subscribers.delete(fn);
					},
				};
			},
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			subscribers.clear();
			watch.dispose();
		},
	};
}

/** 一个集成的设置从哪读、什么时候说「可能变了」:内置集成由 {@link settingsReaderOptionsOf} 按集成键造。 */
type SettingsReaderOptions = Pick<CreateSettingsReaderOptions<unknown>, "read" | "onChanged">;

/**
 * 「按集成键要设置的读法」:读配置仓里那一段、只在 `integration-settings` 变时说一声。入口造一次,
 * 递给每个造内置集成上下文的地方 —— 核心不认识任何具体集成的键,键由各集成在自己那儿挑。
 * 只 `import type` 配置仓(集成目录不碰盘,守卫 `integration-no-fs`)。
 */
export function settingsReaderOptionsOf(
	store: Pick<ConfigStore, "readIntegrationSettings" | "onChange">,
): (key: string) => SettingsReaderOptions {
	return (key) => ({
		read: () => store.readIntegrationSettings(key),
		onChanged: (fn) =>
			store.onChange((scope) => {
				if (scope === "integration-settings") fn();
			}),
	});
}

/**
 * 一个集成的 `ctx.settings(规则)`:每交一份规则造一个读手,收摊时(`dispose`)一起摘。已经收掉了才来要的,
 * 当场摘掉宿主那头的监听(免得没人摘),`get()` 照常能读。内置集成用它;拓展有自己的实现(要对表清单、认
 * 「设置读不了」),不走这里。
 */
export function createIntegrationSettings(opts: SettingsReaderOptions & { logger: Logger }): {
	settings<T>(schema: ZodType<T>): SettingsReader<T>;
	dispose(): void;
} {
	const readers = new Set<{ dispose(): void }>();
	let disposed = false;
	return {
		settings(schema) {
			const { reader, dispose } = createSettingsReader({ ...opts, schema });
			if (disposed) dispose();
			else readers.add({ dispose });
			return reader;
		},
		dispose() {
			disposed = true;
			for (const entry of readers) entry.dispose();
			readers.clear();
		},
	};
}
