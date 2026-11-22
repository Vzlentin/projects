/**
 * The `thread`, `rule`, `parley` and `item` tools of a Pi session, on the store of the project of the session's host, the
 * digest of the session before each turn, and the section of the decided rules in the system prompt of each turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Projects } from "./index.ts";

/**
 * Registers the tools of the store of the project, whose caller is the session ID. Before each turn, the session gets
 * its digest from the host, which it starts when none runs, as a custom message `harness-digest`, when the digest
 * changed since its last one or the session has a newer compaction since then, and the decided rules of the project as
 * the system prompt section `RULES_SECTION`.
 */
export function registerProject(
	pi: ExtensionAPI,
	projects: Pick<Projects, "client" | "projectProtocol" | "projectTool" | "protocol" | "requests" | "tool">,
): void {
	const { client, projectProtocol, projectTool, protocol, requests, tool } = projects;

	projectTool.projectTools({ Type }, (project) =>
		pi.registerTool({
			name: project.name,
			label: project.label,
			description: project.description,
			parameters: project.parameters,
			outputSchema: project.output,
			// Each call has its own connection, so calls at the same time can reach the host out of order.
			executionMode: "sequential",
			async execute(_toolCallId, args, signal, _onUpdate, ctx) {
				const scope = { caller: ctx.sessionManager.getSessionId(), send: tool.sendToHost, signal };
				const { text, data } = await project.run(args, scope);

				return { content: [{ type: "text", text }], details: undefined, structuredContent: data };
			},
		}),
	);

	// The digest starts the host, so a first turn and a turn after the host exited get the board.
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const caller = ctx.sessionManager.getSessionId();
			// The newest compaction cut the earlier digests from the context, so a new one gives the digest again.
			const head = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.id;
			const request = head === undefined ? { type: "digest", caller } : { type: "digest", caller, head };
			const reply = await client.requestEntry(request, { start: true });
			const { text } = requests.replyOf(projectProtocol.DigestReply, reply, "digest");

			if (text === undefined) return undefined;

			return { message: { customType: "harness-digest", content: text, display: false } };
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`harness: no digest: ${protocol.errorMessage(error)}`, "warning");

			return undefined;
		}
	});

	// Pi copies the sections at each turn, so a turn with no host or no decided rule has no section of the rules.
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const request = { type: "rule", action: "list", status: "decided" };
			const reply = await client.requestEntry(request, { start: false });

			const text =
				reply === undefined
					? undefined
					: projectProtocol.rulesSection(requests.replyOf(projectProtocol.RuleList, reply, "list of rules").rules);

			if (text !== undefined) event.systemPromptOptions.sections[projectProtocol.RULES_SECTION] = text;
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`harness: no rules: ${protocol.errorMessage(error)}`, "warning");
		}

		return undefined;
	});
}
