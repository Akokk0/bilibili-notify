import {
	type Connection,
	type Disposable,
	type ExtensionManifestField,
	type GlobalConfig,
	mapMarked,
} from "@bilibili-notify/internal";
import { collectRedactions } from "../backup/sanitize.js";
import { type BootstrapConfig, BootstrapConfigSchema } from "../config/schema.js";
import type { ConfigStore } from "../config/store.js";
import { maskSettings } from "../extensions/settings-io.js";
import { stringLeaves, type ValueRedactor } from "../logs/value-redactor.js";
import type { SecretCellsReader } from "../push/connection-settings.js";
import type { PlatformAdapterRegistry } from "../push/registry.js";

/**
 * 设置里标了机密的格,值登记进日志按值打码的登记册(ADR-0025 决策 9 下 10-16)。
 *
 * 「哪格是机密」不另写一份:取**面板打码**那一档(`secret` 标记、拓展清单的 `secret` / `generate`)的结果,
 * 用备份的 `collectRedactions` 把「被遮掉的原值」收出来 —— 面板不遮的(`backupOnly`:OneBot 地址、AI baseUrl)
 * 日志里也照显,排查要看的就是这些。第三方拓展什么都不用做。
 *
 * 面板打码的函数在 `routes/`,`runtime/` 不许 import 路由,所以由入口作为 {@link SettingsRedactionViews} 注入。
 * 归属记在核心自己名下(`core`),不记在各集成名下:拓展停下时存储把手会撤掉它名下的一切,而它的设置还在盘上。
 */

/** 登记册里的归属与种类。拓展 id 不许叫 `core`,撞不上任何集成。 */
const OWNER = "core";
const KIND = "settings";

/** 面板打码的三个函数(入口从 `routes/secret-view.ts` 递进来)。 */
interface SettingsRedactionViews {
	globals(globals: GlobalConfig): unknown;
	connection(connection: Connection, lookup: SecretCellsReader): { settings?: unknown };
	integrationSettings(schema: unknown, settings: unknown): unknown;
}

/**
 * 引导配置里标了机密的格（面板密码、at-rest 口令）的值。引导配置运行中不变，开机时就在手上，
 * 建运行时那一刻登记一次、种类 `bootstrap`，不随设置换。`chromeEndpoint` 不登记（多数不带 token，
 * 带了整串都会被遮，排查时连连的哪都看不出）。
 */
export function secretBootstrapValues(bootstrap: BootstrapConfig): string[] {
	const found: string[] = [];
	mapMarked(BootstrapConfigSchema, bootstrap, {
		onMark: (value, mark) => {
			if ("secret" in mark) found.push(...stringLeaves(value));
			return value;
		},
		onUntyped: (value) => value,
	});
	return found;
}

/** 原件与打码后的那份比一遍,被遮掉的每一处的原值里的字符串。 */
function maskedStrings(original: unknown, masked: unknown): string[] {
	return collectRedactions(original, masked).flatMap((leaf) => stringLeaves(leaf.value));
}

/**
 * 此刻设置里该登记的值(去重)。四样来源:核心设置、连接设置、内置集成登记段、拓展设置。
 * 问不出「哪格是机密」的(适配器不在场、设置解不过、拓展没清单)从严,整份里的字符串都收 ——
 * 同面板的规矩。
 */
export function secretSettingValues(input: {
	views: SettingsRedactionViews;
	globals: GlobalConfig;
	connections: readonly Connection[];
	connectionSecrets: SecretCellsReader;
	integrationSettings: ReadonlyArray<{ schema: unknown; settings: unknown }>;
	extensionSettings: Record<string, unknown>;
	/** 拓展清单里的设置字段;清单读不到回 `undefined`。 */
	extensionFieldsOf(id: string): readonly ExtensionManifestField[] | undefined;
}): string[] {
	const { views } = input;
	const values = new Set<string>(maskedStrings(input.globals, views.globals(input.globals)));
	for (const connection of input.connections) {
		const view = views.connection(connection, input.connectionSecrets);
		for (const value of maskedStrings(connection.settings, view.settings)) values.add(value);
	}
	for (const { schema, settings } of input.integrationSettings) {
		for (const value of maskedStrings(settings, views.integrationSettings(schema, settings))) {
			values.add(value);
		}
	}
	for (const [id, stored] of Object.entries(input.extensionSettings)) {
		const fields = input.extensionFieldsOf(id);
		const found = fields
			? maskedStrings(stored, maskSettings(fields, stored))
			: stringLeaves(stored);
		for (const value of found) values.add(value);
	}
	return [...values];
}

/**
 * 把设置里的机密值接到登记册上:当场登记一次,之后设置变了、适配器来去了就**整批换**。
 * 入口在配置读完之后立刻调;拓展装载是后面的事,装好之后调一次 `sync()`(清单到手才能从「整份遮」变窄)。
 *
 * `dispose` 只撤订阅、不撤已登记的值:关停的 flush 段还会打日志。
 */
export function bindSettingsRedaction(opts: {
	redactor: Pick<ValueRedactor, "replace">;
	views: SettingsRedactionViews;
	configStore: Pick<
		ConfigStore,
		| "getGlobals"
		| "getConnections"
		| "readIntegrationSettings"
		| "getAllExtensionSettings"
		| "onChange"
	>;
	/** 内置集成的设置段(配置仓构造时定的那一份)。 */
	integrationSettings: ReadonlyArray<{ key: string; schema: unknown }>;
	connectionSecrets: SecretCellsReader;
	adapters: Pick<PlatformAdapterRegistry, "onChange">;
	extensionFieldsOf(id: string): readonly ExtensionManifestField[] | undefined;
}): Disposable & { sync(): void } {
	let last: string | undefined;
	const sync = (): void => {
		const integrationSettings = opts.integrationSettings.flatMap((segment) => {
			// 读不懂的那一份(文件不是合法 JSON)仓里没有原文,没得登记。
			const read = opts.configStore.readIntegrationSettings(segment.key);
			return read.ok ? [{ schema: segment.schema, settings: read.settings }] : [];
		});
		const values = secretSettingValues({
			views: opts.views,
			globals: opts.configStore.getGlobals(),
			connections: opts.configStore.getConnections(),
			connectionSecrets: opts.connectionSecrets,
			integrationSettings,
			extensionSettings: opts.configStore.getAllExtensionSettings(),
			extensionFieldsOf: opts.extensionFieldsOf,
		});
		// 一样就不换:探测状态写回之类每次都发 `config-changed`。
		const key = JSON.stringify(values.sort());
		if (key === last) return;
		last = key;
		opts.redactor.replace(OWNER, KIND, values);
	};
	sync();
	const subscriptions = [
		opts.configStore.onChange((scope) => {
			if (scope === "globals" || scope === "connections" || scope === "integration-settings") {
				sync();
			}
		}),
		opts.adapters.onChange(sync),
	];
	return {
		sync,
		dispose() {
			for (const subscription of subscriptions) subscription.dispose();
		},
	};
}
