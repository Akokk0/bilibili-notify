import type { AIPersona, Result } from "@bilibili-notify/internal";

/** 分享包不携带本地身份、默认或订阅指针。 */
export interface PersonaContent {
	label: string;
	persona: AIPersona;
	dynamicPrompt?: string;
	liveSummaryPrompt?: string;
}

export const PERSONA_FILE_LIMITS = { bytes: 256 * 1024 } as const;

export interface PersonaFile extends PersonaContent {
	schemaVersion: 1;
	kind: "maid-persona";
}

export interface PersonaEntry extends PersonaContent {
	id: string;
	builtin: boolean;
	usedBy: string[];
}

export interface PersonaCatalogResponse {
	revision: string;
	entries: PersonaEntry[];
	removedBuiltins: Array<{ id: string; label: string }>;
}

export type PersonaWriteRequest = { revision: string } & (
	| { op: "create"; content: PersonaContent }
	| { op: "update"; id: string; content: PersonaContent }
	| { op: "remove" | "restore"; id: string }
);
export type PersonaWriteResult = Result<{ id: string }>;
export type PersonaImportPreviewResponse = Result<{ content: PersonaContent }>;
