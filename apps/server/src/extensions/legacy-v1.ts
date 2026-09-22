import type {
	ExtensionConfigField,
	ExtensionDescriptor,
	ExtensionDisplay,
	ExtensionScalarField,
} from "@bilibili-notify/extension";

/**
 * **v1 的退路** —— v1 拓展在代码里交外观与连接配置项,用的是老名字(ADR-0019 决策 17 的改名
 * 之前那一套)。宿主收下的那一刻翻译成新形状,**宿主里只有新形状**:面板、脱敏、对表都只认
 * 一种,不必各自再分一次档。
 *
 * 只剩桥还在用。桥迁到 v2、再抬 `EXTENSION_API_RANGE.min` 之后,这个文件整个删掉。
 */

/** `tint` → `color`。 */
export function displayFromV1(descriptor: ExtensionDescriptor): ExtensionDisplay {
	return { label: descriptor.label, shortLabel: descriptor.shortLabel, color: descriptor.tint };
}

/** 去掉值为 `undefined` 的格 —— 老形状里没写的,新形状里也就没有,而不是一格 `undefined`。 */
function defined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * `code → key`、`kind → type`(`text → string`、`toggle → boolean`、`select → enum`)、
 * `hint → description`、`suffix → unit`、`mono → monospace`。
 */
export function fieldFromV1(field: ExtensionConfigField): ExtensionScalarField {
	const base = {
		key: field.code,
		label: field.label,
		description: field.hint,
		required: field.required,
	};
	switch (field.kind) {
		case "text":
			return defined({
				...base,
				type: "string",
				placeholder: field.placeholder,
				monospace: field.mono,
				secret: field.secret,
			});
		case "number":
			return defined({
				...base,
				type: "number",
				min: field.min,
				max: field.max,
				step: field.step,
				unit: field.suffix,
			});
		case "toggle":
			return defined({ ...base, type: "boolean" });
		case "select":
			return defined({ ...base, type: "enum", options: field.options });
	}
}
