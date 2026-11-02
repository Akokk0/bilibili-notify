import {
	type ExtensionApiRange,
	ExtensionIdSchema,
	type ExtensionManifestRead,
	parseExtensionManifest,
} from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";

/** 通用格式与核心保留名之外，再核对本宿主装配的集成键。 */
export function extensionIdSchema(reservedIntegrationKeys: readonly string[]) {
	return ExtensionIdSchema.refine((id) => !reservedIntegrationKeys.includes(id), {
		error: () => t("extensions.route.badId"),
	});
}

export function parseHostExtensionManifest(
	raw: unknown,
	range: ExtensionApiRange,
	reservedIntegrationKeys: readonly string[],
): ExtensionManifestRead {
	return parseExtensionManifest(raw, range, extensionIdSchema(reservedIntegrationKeys));
}
