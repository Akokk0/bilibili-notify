import type { InvalidSettingView } from "@bilibili-notify/contract";
import {
	hasSecretCells,
	type Issue,
	isSecretField,
	type SettingsField,
	settingsValueSchema,
} from "@bilibili-notify/internal";
import type { ZodType } from "zod";
import { t } from "../i18n/index.js";
import type { InvalidSettingEntry } from "./core-settings.js";

/** Never forward arbitrary validator text: it may interpolate the submitted credential. */
export function safeSettingsIssues(
	issues: readonly { path?: readonly PropertyKey[]; code?: string }[],
): Issue[] {
	const messageOf = (code: string | undefined): string => {
		switch (code) {
			case "invalid_type":
				return t("settings.invalid.type");
			case "too_small":
				return t("settings.invalid.small");
			case "too_big":
				return t("settings.invalid.big");
			case "invalid_format":
				return t("settings.invalid.format");
			case "invalid_value":
				return t("settings.invalid.option");
			default:
				return t("settings.invalid.rule");
		}
	};
	return issues.map((issue) => ({
		path: (issue.path ?? []).filter(
			(part): part is string | number => typeof part === "string" || typeof part === "number",
		),
		message: messageOf(issue.code),
	}));
}

export function invalidSettingView(
	schema: unknown,
	entry: InvalidSettingEntry,
): InvalidSettingView & { path: string[] } {
	let issues: Issue[];
	try {
		const parsed = (schema as ZodType | undefined)?.safeParse(entry.raw);
		issues =
			parsed && !parsed.success
				? safeSettingsIssues(parsed.error.issues)
				: safeSettingsIssues(entry.issues);
	} catch {
		issues = safeSettingsIssues(entry.issues);
	}
	if (issues.length === 0) issues = safeSettingsIssues([{}]);
	const common = { path: [...entry.path], issues };
	return hasSecretCells(schema)
		? { ...common, secret: true }
		: { ...common, secret: false, raw: structuredClone(entry.raw), missing: entry.missing };
}

/** Top-level rules of an extension; unknown compositions deliberately fail closed. */
function cellSchema(schema: ZodType, key: string): unknown {
	let cursor: unknown = schema;
	for (let depth = 0; depth < 16; depth++) {
		const def = (cursor as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
		if (!def) return schema;
		if (def.type === "object") return (def.shape as Record<string, unknown>)[key];
		cursor = def.innerType ?? (def.type === "pipe" ? def.out : undefined);
		if (!cursor) return schema;
	}
	return schema;
}

/** Async refinements remain extension-owned; only safe, top-level cells cross this boundary. */
export async function extensionInvalidSettings(
	fields: readonly SettingsField[],
	schemas: readonly ZodType[],
	stored: unknown,
): Promise<InvalidSettingView[]> {
	if (stored === undefined) return [];
	const rules = [settingsValueSchema(fields), ...schemas];
	const object =
		typeof stored === "object" && !Array.isArray(stored)
			? (stored as Record<string, unknown>)
			: undefined;
	const grouped = new Map<string, Issue[]>();
	for (const schema of rules) {
		const parsed = await schema.safeParseAsync(stored);
		if (parsed.success) continue;
		for (const issue of parsed.error.issues) {
			const head = typeof issue.path[0] === "string" && object ? issue.path[0] : "";
			const previous = grouped.get(head) ?? [];
			previous.push(...safeSettingsIssues([issue]));
			grouped.set(head, previous);
		}
	}
	return Array.from(grouped, ([key, issues]): InvalidSettingView => {
		const field = fields.find((candidate) => candidate.key === key);
		const declaresSecret = (candidate: SettingsField) =>
			isSecretField(candidate) ||
			(candidate.type === "list" && candidate.fields.some(isSecretField));
		const declaredSecret = key ? field && declaresSecret(field) : fields.some(declaresSecret);
		const schemasForCell = key
			? schemas.map((schema) => cellSchema(schema, key)).filter((schema) => schema !== undefined)
			: schemas;
		const secret = Boolean(
			declaredSecret ||
				(key && !field && schemasForCell.length === 0) ||
				schemasForCell.some(hasSecretCells),
		);
		const common = { path: key ? [key] : [], issues };
		return secret
			? { ...common, secret: true }
			: {
					...common,
					secret: false,
					raw: structuredClone(key ? object?.[key] : stored),
					missing: key ? !object || !Object.hasOwn(object, key) : false,
				};
	});
}
