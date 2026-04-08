import type { PluginInput } from "@opencode-ai/plugin";

export function buildNotification(title: string, output: string): string {
	return [`▣ ${title}`, "", output].join("\n");
}

export function createNotificationSender(input: {
	client: PluginInput["client"];
	service: string;
}): (sessionID: string, message: string) => Promise<void> {
	return async (sessionID: string, message: string): Promise<void> => {
		try {
			await input.client.session.prompt({
				path: { id: sessionID },
				body: {
					noReply: true,
					parts: [{ type: "text", text: message, ignored: true }],
				},
			});
		} catch (error: unknown) {
			const messageText =
				error instanceof Error ? error.message : String(error);
			await input.client.app.log({
				body: {
					service: input.service,
					level: "debug",
					message: `failed to send notification: ${messageText}`,
				},
			});
		}
	};
}
