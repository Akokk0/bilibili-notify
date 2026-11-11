#!/usr/bin/env node
import { parseArgs } from "node:util";
import { launchRuntime } from "./runtime";

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			help: { type: "boolean", short: "h" },
			"data-dir": { type: "string" },
			port: { type: "string" },
			"cache-dir": { type: "string" },
		},
	});
	if (values.help || positionals.length === 0) {
		console.log(
			"bn web  Run the packaged web host\nbn dev  Run the packaged extension development host\n\nOptions: --data-dir <directory> --port <port> --cache-dir <directory>",
		);
		return;
	}
	const [profile] = positionals;
	if (positionals.length !== 1 || (profile !== "web" && profile !== "dev"))
		throw new Error("Unknown command. Run bn --help.");
	const port = Number(values.port ?? process.env.BN_PORT ?? "8787");
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("Port must be between 1 and 65535.");
	await launchRuntime({
		profile,
		port,
		dataDir: values["data-dir"],
		cacheDir: values["cache-dir"],
	});
}

main().catch((error: unknown) => {
	console.error(`bn: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
