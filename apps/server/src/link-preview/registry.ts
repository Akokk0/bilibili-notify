import type { Disposable, LinkResolver } from "@bilibili-notify/internal";
import { createRegistry } from "../integrations/registry.js";

/**
 * 链接解析器的登记表:一个集成键一个主人。解析器由集成在自己的 `start(ctx)` 里经
 * `ctx.registerLinkResolver` 登进来(键取自来源,来源不自己给)。
 */
export interface LinkResolverRegistry {
	/** 认领键、放进解析器;键被占了就抛。把手 `dispose` 只撤自己这一行,撤了可以重登。 */
	register(key: string, resolver: LinkResolver): Disposable;
	/** 全表,按登记先后(撤了重登的排到最后)。带键:冷却要拿它拼键。 */
	entries(): Iterable<[string, LinkResolver]>;
}

export function createLinkResolverRegistry(): LinkResolverRegistry {
	const table = createRegistry<LinkResolver>(
		(key) => `link resolver for key "${key}" is already registered`,
	);
	return {
		register: (key, resolver) => table.claim(key, resolver),
		entries: () => table.entries(),
	};
}
