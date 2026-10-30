import type { InvalidSettingView } from "@bilibili-notify/contract";
import {
	hasSecretCells,
	type Issue,
	isSecretField,
	type SettingsField,
	secretMarkOf,
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

/** Retain every rule governing a cell, including marks on its ancestors. Never select by value. */
function cellSchemas(schema: ZodType, key: string): unknown[] {
	const visit = (node: unknown, ancestors: ReadonlySet<unknown>, depth: number): unknown[] => {
		const mark = secretMarkOf(node);
		if (mark && "secret" in mark) return [node];
		if (depth > 32 || ancestors.has(node)) return [undefined];
		const def = (node as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
		if (!def) return [node];
		const seen = new Set(ancestors).add(node);
		const next = (child: unknown) => visit(child, seen, depth + 1);
		if (def.innerType !== undefined) return next(def.innerType);
		switch (def.type) {
			case "pipe":
				return [...next(def.in), ...next(def.out)];
			case "union":
				return (def.options as unknown[]).flatMap(next);
			case "intersection":
				return [...next(def.left), ...next(def.right)];
			case "lazy":
				return next((def.getter as () => unknown)());
			case "object": {
				const shape = def.shape as Record<string, unknown>;
				if (Object.hasOwn(shape, key)) return [shape[key]];
				const catchall = def.catchall as { _zod?: { def?: { type?: string } } } | undefined;
				return catchall && catchall._zod?.def?.type !== "never" ? [catchall] : [];
			}
			case "record":
				return [def.valueType];
			default:
				return [node];
		}
	};
	return visit(schema, new Set(), 0);
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
		const schemasForCell = key ? schemas.flatMap((schema) => cellSchemas(schema, key)) : schemas;
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
