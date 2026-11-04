import type {
	ClearableStorageCategory,
	GenerationLockReason,
	StorageCategory,
} from "@bilibili-notify/contract";
import { i18n } from "../../i18n";

/** Read at render time; no translated labels are cached across locale changes. */
export function storageCategoryText(category: StorageCategory): { label: string; hint: string } {
	switch (category) {
		case "stats":
			return {
				label: i18n.t("storageUsage.category.stats"),
				hint: i18n.t("storageUsage.hint.stats"),
			};
		case "historyText":
			return {
				label: i18n.t("storageUsage.category.historyText"),
				hint: i18n.t("storageUsage.hint.historyText"),
			};
		case "historyImages":
			return {
				label: i18n.t("storageUsage.category.historyImages"),
				hint: i18n.t("storageUsage.hint.historyImages"),
			};
		case "ai":
			return { label: i18n.t("storageUsage.category.ai"), hint: i18n.t("storageUsage.hint.ai") };
		case "logs":
			return {
				label: i18n.t("storageUsage.category.logs"),
				hint: i18n.t("storageUsage.hint.logs"),
			};
		case "otherImages":
			return {
				label: i18n.t("storageUsage.category.otherImages"),
				hint: i18n.t("storageUsage.hint.otherImages"),
			};
		case "generations":
			return {
				label: i18n.t("storageUsage.category.generations"),
				hint: i18n.t("storageUsage.hint.generations"),
			};
	}
}

export function storageClearScope(category: ClearableStorageCategory): string {
	switch (category) {
		case "stats":
			return i18n.t("storageUsage.clearScope.stats");
		case "historyText":
			return i18n.t("storageUsage.clearScope.historyText");
		case "historyImages":
			return i18n.t("storageUsage.clearScope.historyImages");
		case "ai":
			return i18n.t("storageUsage.clearScope.ai");
	}
}

export function generationLockText(reason: GenerationLockReason): string {
	switch (reason) {
		case "current":
			return i18n.t("storageUsage.lock.current");
		case "partial":
			return i18n.t("storageUsage.lock.partial");
		case "unreadable":
			return i18n.t("storageUsage.lock.unreadable");
		case "newer-format":
			return i18n.t("storageUsage.lock.newer-format");
		case "protected-source":
			return i18n.t("storageUsage.lock.protected-source");
		case "protected-previous":
			return i18n.t("storageUsage.lock.protected-previous");
		case "current-age-unknown":
			return i18n.t("storageUsage.lock.current-age-unknown");
	}
}
