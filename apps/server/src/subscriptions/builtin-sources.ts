import type { AuthState, Disposable, Source } from "@bilibili-notify/internal";
import type { ProblemTable } from "../problems/problem-table.js";
import type { SourceRegistry } from "./registry.js";
import { type CreateSourceContextOptions, createSourceContext } from "./source-context.js";

export interface RegisterBuiltinSourceOptions
	extends Omit<CreateSourceContextOptions, "descriptor" | "problems"> {
	/** 问题表:来源的上下文往里写;来源停下(撤登记、登记失败)时它报的整批清掉,不补「已恢复」。 */
	problems: Pick<ProblemTable, "report" | "resolve" | "clearReporter">;
	registry: SourceRegistry;
	source: Source;
	/**
	 * 来源有登录口(`source.auth`)的话,它的状态或账号变了就叫一声,带此刻的状态。登记成功之后才订阅
	 * (登记时不补发,面板进来走 `GET`);撤登记时摘掉。宿主不替来源去重。
	 */
	onAuthChanged?: (state: AuthState) => void;
}

/**
 * 给一个内置来源建上下文并登记(登记即 `start`)。交回的把手:先撤登记(触发 `stop`),再收上下文。
 * 登记失败(键被占、`start` 抛):先收上下文,再把错抛出去。
 *
 * 来源停下之后它报的问题整批清掉(`clearReporter`):这是宿主在清,不是来源说「好了」,所以不会补「已恢复」。
 * 登记失败那一支也清一次 —— `start` 途中可能已经报过。
 */
export async function registerBuiltinSource(
	opts: RegisterBuiltinSourceOptions,
): Promise<Disposable> {
	const { registry, source, onAuthChanged, ...rest } = opts;
	const handle = createSourceContext({ ...rest, descriptor: source.descriptor });
	let registration: Disposable;
	try {
		registration = await registry.register(opts.sourceKey, source, handle.ctx);
	} catch (err) {
		handle.dispose();
		opts.problems.clearReporter(opts.sourceKey);
		throw err;
	}
	const auth = source.auth;
	const authSubscription =
		auth && onAuthChanged ? auth.onChange(() => onAuthChanged(auth.state())) : undefined;
	return {
		dispose() {
			authSubscription?.dispose();
			registration.dispose();
			handle.dispose();
			opts.problems.clearReporter(opts.sourceKey);
		},
	};
}
