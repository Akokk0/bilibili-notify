/** Bootstrap flags are applied in command-line order, with the last value winning. */
export function bootstrapCli(argv: readonly string[]): Map<string, string> {
	const options = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token?.startsWith("--")) continue;
		const body = token.slice(2);
		const eq = body.indexOf("=");
		if (eq >= 0) {
			options.set(body.slice(0, eq), body.slice(eq + 1));
		} else {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				options.set(body, next);
				i++;
			} else options.set(body, "true");
		}
	}
	return options;
}
