import { createHash, randomUUID } from "node:crypto";
import {
	PERSONA_FILE_LIMITS,
	type PersonaCatalogResponse,
	type PersonaEntry,
} from "@bilibili-notify/contract";
import {
	AIPersonaSchema,
	fail,
	type GlobalConfig,
	issuesFromZod,
	ok,
} from "@bilibili-notify/internal";
import { presetsOf } from "@bilibili-notify/internal/ai";
import { textSettingsOf } from "@bilibili-notify/internal/i18n";
import { builtinPresetsFor } from "@bilibili-notify/internal/texts/builtin";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ConfigStore } from "../config/store.js";
import { t } from "../i18n/index.js";
import { respondFailure } from "./respond-failure.js";
import { MULTIPART_OVERHEAD_BYTES } from "./upload-limit.js";

const contentSchema = z
	.object({
		label: z.string().trim().min(1),
		persona: AIPersonaSchema.strict(),
		dynamicPrompt: z.string().optional(),
		liveSummaryPrompt: z.string().optional(),
	})
	.strict();
const fileSchema = contentSchema
	.extend({ schemaVersion: z.literal(1), kind: z.literal("maid-persona") })
	.strict();
const fileOf = (content: z.infer<typeof contentSchema>) => ({
	schemaVersion: 1,
	kind: "maid-persona",
	label: content.label,
	persona: content.persona,
	dynamicPrompt: content.dynamicPrompt,
	liveSummaryPrompt: content.liveSummaryPrompt,
});
const fitsFile = (content: z.infer<typeof contentSchema>) =>
	Buffer.byteLength(JSON.stringify(fileOf(content), null, 2)) <= PERSONA_FILE_LIMITS.bytes;
const requestSchema = z.discriminatedUnion("op", [
	z.object({ op: z.literal("create"), revision: z.string(), content: contentSchema }).strict(),
	z
		.object({
			op: z.literal("update"),
			revision: z.string(),
			id: z.string(),
			content: contentSchema,
		})
		.strict(),
	z.object({ op: z.literal("remove"), revision: z.string(), id: z.string() }).strict(),
	z.object({ op: z.literal("restore"), revision: z.string(), id: z.string() }).strict(),
]);
const builtinsOf = (globals: GlobalConfig) => builtinPresetsFor(textSettingsOf(globals).locale);
const revisionOf = (globals: GlobalConfig) =>
	createHash("sha256")
		.update(
			JSON.stringify([
				textSettingsOf(globals).locale,
				globals.ai.presets,
				globals.ai.removedBuiltinPresets ?? [],
			]),
		)
		.digest("hex");

function entriesOf(globals: GlobalConfig, store: ConfigStore): PersonaEntry[] {
	const builtins = builtinsOf(globals);
	const list = presetsOf(globals.ai, builtins);
	const active = list.some((p) => p.id === globals.ai.activePreset)
		? globals.ai.activePreset
		: list[0]?.id;
	return list.map((p) => ({
		...p,
		builtin: builtins.some((b) => b.id === p.id),
		usedBy: [
			...(p.id === active ? [t("personas.usage.default")] : []),
			...store
				.getSubscriptions()
				.filter((sub) => sub.overrides.ai?.preset === p.id)
				.map((sub) => t("personas.usage.subscription", { id: sub.id })),
		],
	}));
}

export function createAiPersonasRoute(store: ConfigStore): Hono {
	const app = new Hono();
	app.post(
		"/import-preview",
		bodyLimit({
			maxSize: PERSONA_FILE_LIMITS.bytes + MULTIPART_OVERHEAD_BYTES,
			onError: (c) => respondFailure(c, fail("invalid", t("personas.tooLarge")), 413),
		}),
		async (c) => {
			const body = await c.req.parseBody().catch(() => null);
			if (!(body?.file instanceof File))
				return respondFailure(c, fail("invalid", t("personas.invalid")));
			if (body.file.size > PERSONA_FILE_LIMITS.bytes)
				return respondFailure(c, fail("invalid", t("personas.tooLarge")), 413);
			const parsed = fileSchema.safeParse(
				await body.file
					.text()
					.then((text) => JSON.parse(text))
					.catch(() => null),
			);
			if (!parsed.success)
				return respondFailure(
					c,
					fail("invalid", t("personas.invalid"), { issues: issuesFromZod(parsed.error) }),
				);
			const { schemaVersion: _version, kind: _kind, ...content } = parsed.data;
			if (!fitsFile(content))
				return respondFailure(c, fail("invalid", t("personas.tooLarge")), 413);
			return c.json(ok({ content }));
		},
	);
	app.get("/:id/export", (c) => {
		const entry = entriesOf(store.getGlobals(), store).find((p) => p.id === c.req.param("id"));
		if (!entry) return respondFailure(c, fail("not_found", t("personas.missing")));
		if (!fitsFile(entry)) return respondFailure(c, fail("invalid", t("personas.tooLarge")), 413);
		return c.body(JSON.stringify(fileOf(entry), null, 2), 200, {
			"content-type": "application/json; charset=utf-8",
			"content-disposition": 'attachment; filename="persona.json"',
		});
	});
	app.get("/", (c) => {
		const globals = store.getGlobals();
		const body: PersonaCatalogResponse = {
			revision: revisionOf(globals),
			entries: entriesOf(globals, store),
			removedBuiltins: builtinsOf(globals)
				.filter((p) => globals.ai.removedBuiltinPresets?.includes(p.id))
				.map(({ id, label }) => ({ id, label })),
		};
		return c.json(body);
	});
	app.post(
		"/",
		bodyLimit({
			maxSize: PERSONA_FILE_LIMITS.bytes + MULTIPART_OVERHEAD_BYTES,
			onError: (c) => respondFailure(c, fail("invalid", t("personas.tooLarge")), 413),
		}),
		async (c) => {
			const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
			if (!parsed.success)
				return respondFailure(
					c,
					fail("invalid", t("personas.invalid"), { issues: issuesFromZod(parsed.error) }),
				);
			const change = parsed.data;
			if ((change.op === "create" || change.op === "update") && !fitsFile(change.content))
				return respondFailure(c, fail("invalid", t("personas.tooLarge")), 413);
			const result = await store.updateGlobalsResult<string>((current) => {
				if (change.revision !== revisionOf(current)) return fail("conflict", t("personas.stale"));
				const ai = current.ai;
				const entries = entriesOf(current, store);
				let id: string;
				if (change.op === "create" || change.op === "update") {
					if (change.op === "update") {
						const entry = entries.find((p) => p.id === change.id);
						if (!entry) return fail("not_found", t("personas.missing"));
						if (entry.builtin) return fail("conflict", t("personas.readonly"));
					}
					if (
						entries.some(
							(p) =>
								p.label === change.content.label && (change.op === "create" || p.id !== change.id),
						)
					)
						return fail("conflict", t("personas.nameTaken"));
					id = change.op === "create" ? `persona-${randomUUID()}` : change.id;
					const content = {
						...change.content,
						dynamicPrompt: change.content.dynamicPrompt || undefined,
						liveSummaryPrompt: change.content.liveSummaryPrompt || undefined,
					};
					ai.presets =
						change.op === "create"
							? [...ai.presets, { id, ...content }]
							: ai.presets.map((p) => (p.id === id ? { id, ...content } : p));
				} else {
					id = change.id;
					if (change.op === "restore") {
						if (
							!builtinsOf(current).some((p) => p.id === id) ||
							!ai.removedBuiltinPresets?.includes(id)
						)
							return fail("not_found", t("personas.missing"));
						ai.removedBuiltinPresets = ai.removedBuiltinPresets.filter((p) => p !== id);
					} else {
						const entry = entries.find((p) => p.id === id);
						if (!entry) return fail("not_found", t("personas.missing"));
						if (entry.usedBy.length)
							return fail("conflict", t("personas.inUse", { usage: entry.usedBy.join("、") }));
						if (entries.length <= 1) return fail("conflict", t("personas.last"));
						if (entry.builtin) ai.removedBuiltinPresets = [...(ai.removedBuiltinPresets ?? []), id];
						else ai.presets = ai.presets.filter((p) => p.id !== id);
					}
				}
				return ok({ globals: current, value: id });
			});
			if (!result.ok) return respondFailure(c, result);
			return c.json(ok({ id: result.value }));
		},
	);
	return app;
}
