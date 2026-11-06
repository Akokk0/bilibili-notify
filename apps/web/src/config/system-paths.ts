const INTEGRATION_HASH = "#integration:";

export function integrationSettingsPath(key: string): string {
	return `/system${INTEGRATION_HASH}${encodeURIComponent(key)}`;
}
export function integrationKeyFromHash(hash: string): string | undefined {
	if (!hash.startsWith(INTEGRATION_HASH)) return;
	try {
		return decodeURIComponent(hash.slice(INTEGRATION_HASH.length));
	} catch {
		return;
	}
}
