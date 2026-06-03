const TOKEN_PARAM = "desktopToken";
const TOKEN_STORAGE_KEY = "bn.desktopToken";
const TOKEN_HEADER = "x-bn-desktop-token";

let cachedToken: string | null | undefined;

export function getDesktopToken(): string | null {
	if (cachedToken !== undefined) return cachedToken;
	cachedToken = readTokenFromLocation() ?? readTokenFromSessionStorage();
	return cachedToken;
}

export function withDesktopTokenHeader(headers?: HeadersInit): Headers {
	const next = new Headers(headers);
	const token = getDesktopToken();
	if (token) next.set(TOKEN_HEADER, token);
	return next;
}

export function withDesktopTokenQuery(url: string): string {
	const token = getDesktopToken();
	if (!token) return url;
	const next = new URL(url, location.href);
	next.searchParams.set(TOKEN_PARAM, token);
	return next.toString();
}

function readTokenFromLocation(): string | null {
	if (typeof location === "undefined") return null;
	const url = new URL(location.href);
	const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
	const token = hashParams.get(TOKEN_PARAM);
	const shouldClean = Boolean(token) || url.searchParams.has(TOKEN_PARAM);
	url.searchParams.delete(TOKEN_PARAM);
	hashParams.delete(TOKEN_PARAM);
	if (shouldClean) {
		const hash = hashParams.toString();
		url.hash = hash ? hash : "";
		const clean = `${url.pathname}${url.search}${url.hash}`;
		try {
			history.replaceState(history.state, "", clean);
		} catch {
			// Non-browser test environments may expose location without history.
		}
	}
	if (!token) return null;
	writeTokenToSessionStorage(token);
	return token;
}

function readTokenFromSessionStorage(): string | null {
	try {
		return sessionStorage.getItem(TOKEN_STORAGE_KEY);
	} catch {
		return null;
	}
}

function writeTokenToSessionStorage(token: string): void {
	try {
		sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
	} catch {
		// If storage is unavailable, the in-memory cache still protects this page load.
	}
}
