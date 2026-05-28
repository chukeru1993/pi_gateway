/**
 * ask.ts - Full-mode compatible question tool
 *
 * Uses ctx.ui.select() / input() instead of ctx.ui.custom()
 * so it works in TUI, RPC, and gateway/Web modes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

// --- Schema ---

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display text (1-5 words, concise)" }),
	description: Type.Optional(Type.String({ description: "Explanation of choice" })),
});

const QuestionSchema = Type.Object({
	question: Type.String({ description: "Complete question" }),
	header: Type.String({ description: "Very short label (max 30 chars)" }),
	options: Type.Array(OptionSchema, { description: "Available choices" }),
	multiple: Type.Optional(Type.Boolean({ description: "Allow multi-select (default: false)" })),
});

const QuestionParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

// --- Types ---

type Option = Static<typeof OptionSchema>;
type Question = Static<typeof QuestionSchema>;
type Params = Static<typeof QuestionParams>;

interface Answer {
	question: string;
	header: string;
	values: string[];
	cancelled: boolean;
}

interface AskResult {
	answers: Answer[];
	cancelled: boolean;
}

// --- Helpers ---

const TIMEOUT = 60_000;
const DONE_MARKER = "✓ Done";
const OTHER_MARKER = "✎ Type your own...";

function renderOptions(options: Option[]): string[] {
	return options.map((opt, i) =>
		opt.description
			? `${i + 1}. ${opt.label} — ${opt.description}`
			: `${i + 1}. ${opt.label}`,
	);
}

function parsePick(selected: string): string {
	// Strip leading "N. " prefix, then drop the last " — description" suffix if present
	const withoutPrefix = selected.replace(/^\d+\.\s*/, "");
	const lastDash = withoutPrefix.lastIndexOf(" — ");
	return lastDash > 0 ? withoutPrefix.slice(0, lastDash).trim() : withoutPrefix.trim();
}

// --- UI primitives ---

interface UILike {
	select(title: string, options: string[], opts?: { timeout?: number; signal?: AbortSignal }): Promise<string | undefined>;
	input(title: string, placeholder?: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<string | undefined>;
}

async function runSingleSelect(
	ui: UILike,
	header: string,
	labels: string[],
	signal?: AbortSignal,
): Promise<string | null> {
	const choices = [...labels, OTHER_MARKER];
	const selected = await ui.select(header, choices, { timeout: TIMEOUT, signal });
	if (selected === undefined) return null;
	if (selected === OTHER_MARKER) {
		const typed = await ui.input(header, "Type your answer...", { timeout: TIMEOUT, signal });
		return typed ?? null;
	}
	return parsePick(selected);
}

async function runMultiSelect(
	ui: UILike,
	header: string,
	labels: string[],
	signal?: AbortSignal,
): Promise<string[] | null> {
	const picked: string[] = [];
	const remaining = [...labels];

	while (remaining.length > 0) {
		const choices = [...remaining, DONE_MARKER, OTHER_MARKER];
		const selected = await ui.select(header, choices, { timeout: TIMEOUT, signal });

		if (selected === undefined) return null;
		if (selected === DONE_MARKER) break;

		if (selected === OTHER_MARKER) {
			const typed = await ui.input(header, "Type your answer...", { timeout: TIMEOUT, signal });
			if (typed === undefined) return null;
			picked.push(typed);
		} else {
			const value = parsePick(selected);
			picked.push(value);
			const idx = remaining.indexOf(selected);
			if (idx !== -1) remaining.splice(idx, 1);
		}
	}

	return picked;
}

// --- Extension ---

export default function ask(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Ask User",
		description:
			"Ask the user one or more questions with predefined options. Use when you need user input or decisions to proceed.",
		parameters: QuestionParams,

		async execute(_toolCallId, params: Params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: Question tool requires UI (running in non-interactive mode)" }],
					details: { answers: [], cancelled: true } as AskResult,
				};
			}
			if (params.questions.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No questions provided" }],
					details: { answers: [], cancelled: true } as AskResult,
				};
			}

			const answers: Answer[] = [];

			for (const q of params.questions) {
				const labels = renderOptions(q.options);

				if (q.multiple) {
					const result = await runMultiSelect(ctx.ui, q.header, labels, signal);
					if (result === null) {
						answers.push({ question: q.question, header: q.header, values: [], cancelled: true });
						return {
							content: [{ type: "text", text: "User cancelled the question" }],
							details: { answers, cancelled: true } as AskResult,
						};
					}
					answers.push({ question: q.question, header: q.header, values: result, cancelled: false });
				} else {
					const result = await runSingleSelect(ctx.ui, q.header, labels, signal);
					if (result === null) {
						answers.push({ question: q.question, header: q.header, values: [], cancelled: true });
						return {
							content: [{ type: "text", text: "User cancelled the question" }],
							details: { answers, cancelled: true } as AskResult,
						};
					}
					answers.push({ question: q.question, header: q.header, values: [result], cancelled: false });
				}
			}

			const lines = answers.map(
				(a) => `"${a.question}" = "${a.values.join(", ")}"`,
			);
			const text = `User has answered your questions:\n${lines.join("\n")}\nYou can now continue with the user's answers in mind.`;

			return {
				content: [{ type: "text", text }],
				details: { answers, cancelled: false } as AskResult,
			};
		},

		renderCall(args: Params, theme) {
			const count = args.questions?.length || 0;
			const headers = (args.questions || []).map((q) => q.header).join(", ");
			let text = theme.fg("toolTitle", theme.bold("question "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (headers) {
				text += theme.fg("dim", ` (${headers})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				const val = a.values.join(", ");
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${val}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
