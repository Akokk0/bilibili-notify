import type { Identity } from "@bilibili-notify/internal";

/** 按来源的叫法拼身份标签:声明了叫法写「UID 123」,否则写「平台 · 123」。 */
export function subscriptionIdentityLabel(
	identity: Pick<Identity, "externalId">,
	platform: { label: string; externalIdNoun?: string },
): string {
	const noun = platform.externalIdNoun?.trim();
	return noun ? `${noun} ${identity.externalId}` : `${platform.label} · ${identity.externalId}`;
}

/** 显示名只有一条链:事件名 → 资料名 → 身份标签。空串与只有空白的都不算名字。 */
export function displayNameOf(
	names: { eventName?: string; profileName?: string },
	identityLabel: string,
): string {
	return filled(names.eventName) ?? filled(names.profileName) ?? identityLabel;
}

function filled(text: string | undefined): string | undefined {
	return text !== undefined && text.trim() !== "" ? text : undefined;
}
