import type { IntegrationStoreHandle } from "../integration-store/store.js";
import {
	type CreateIntegrationContextOptions,
	createIntegrationContext,
	type IntegrationContextHandle,
} from "./context.js";
import {
	type CreateIntegrationHttpOptions,
	createIntegrationHttp,
	type IntegrationHttpHandle,
} from "./http.js";

/**
 * 开一个集成的公共一步:造它的请求客户端(身份与罐子都是它自己的)→ 造上下文 → 把客户端的收尾挂上。
 * B 站、内置适配器、对拍的假来源各开一个,免得各写一遍「先造客户端、失败关存储、再造上下文、挂收尾」。
 * (拓展的上下文由 `createExtensionContext` 在集成上下文之上再包一层,客户端由装载器造,走不到这里。)
 *
 * 存储由调用方开好递进来(`integrations/` 不碰盘),**这里不关它**,谁开的谁关。建到一半失败时:已造的客户端
 * 的收尾(最后一次存盘)在这里做完才抛,把手由调用方关。
 */
export interface OpenIntegrationOptions
	extends Omit<CreateIntegrationContextOptions, "http" | "state" | "secrets" | "redactValues"> {
	/** 这个集成的存储把手:`state` / `secrets` 与按值打码的登记口都取自它。 */
	stores: IntegrationStoreHandle;
	/** 请求客户端的造法(默认头、单跳超时、攒多久存罐子、可回收的定时器);`stores` 与 `logger` 取上面的。 */
	httpOptions: Pick<
		CreateIntegrationHttpOptions,
		"headers" | "timeoutMs" | "saveDelayMs" | "setTimeout"
	>;
}

export interface OpenedIntegration {
	/** 集成上下文,加宿主收回它的那个把手。 */
	readonly handle: IntegrationContextHandle;
	/**
	 * 请求客户端、cookie 罐与身份。上下文收摊时已替它挂了最后一次存盘;**连接池要造它的人收**
	 * (`http.client.dispose()`,时机见 {@link CreateIntegrationContextOptions.http})。
	 */
	readonly http: IntegrationHttpHandle;
}

export async function openIntegration(opts: OpenIntegrationOptions): Promise<OpenedIntegration> {
	const { stores, httpOptions, ...contextOptions } = opts;
	let http: IntegrationHttpHandle;
	try {
		http = await createIntegrationHttp({ stores, logger: opts.logger, ...httpOptions });
	} catch (err) {
		// 上下文还没造出来,设置读手挂着的宿主监听没人替它摘。
		opts.settings.dispose();
		throw err;
	}
	let handle: IntegrationContextHandle;
	try {
		handle = createIntegrationContext({
			...contextOptions,
			state: stores.state,
			secrets: stores.secrets,
			redactValues: (values) => stores.redact("redact", values),
			http: http.client,
		});
	} catch (err) {
		opts.settings.dispose();
		await http.dispose();
		throw err;
	}
	handle.ctx.onDispose(() => http.dispose());
	return { handle, http };
}
