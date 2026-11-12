import { normalizeMarketplaceSourceUrl } from "@bilibili-notify/internal";

export function githubRepository(input: string): string {
	const repository = input
		.trim()
		.replace(/\.git$/i, "")
		.toLowerCase();
	if (!repository || repository.includes(":") || !normalizeMarketplaceSourceUrl(repository).ok)
		throw new Error("Provide a GitHub repository as owner/repo.");
	return repository;
}
