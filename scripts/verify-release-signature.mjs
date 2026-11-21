import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { TRUSTED_UPDATE_KEYS } from "../apps/server/src/update/trusted-keys.ts";

// CI holds the active key A only. B is the offline recovery key.
const { manifest, signature } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const active = TRUSTED_UPDATE_KEYS[0];
if (
	!active ||
	!verify(
		null,
		Buffer.from(manifest, "utf8"),
		createPublicKey({
			key: Buffer.from(active, "base64"),
			format: "der",
			type: "spki",
		}),
		Buffer.from(signature, "base64"),
	)
) {
	throw new Error("Release signature does not match the active client public key.");
}
