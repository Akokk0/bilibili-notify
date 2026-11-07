/** Legacy string assertions still observe both the message and Logger's diagnostic arguments. */
export function logMessage(message: string, args: readonly unknown[] = []): string {
	if (args.length === 0) return message;
	const details = JSON.stringify(args, (_, value) =>
		value instanceof Error ? { name: value.name, message: value.message } : value,
	);
	return `${message} ${details}`;
}
