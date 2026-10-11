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
