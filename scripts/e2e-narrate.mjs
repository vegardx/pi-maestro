#!/usr/bin/env node
// Tail a drive's RPC transcript and print what the maestro is actually doing:
// reasoning, tool calls, questions, worker lifecycle. Meant for a tmux pane —
// the daemon's own stdout is one JSON line and then silence, which tells a
// watcher nothing.
//
//   node scripts/e2e-narrate.mjs <piHome>
//
// Streaming sends the same message repeatedly with a growing body, so only
// terminal (`message_end`) events are printed, and each block is emitted once.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const piHome = process.argv[2];
if (!piHome) {
	console.error("usage: e2e-narrate.mjs <piHome>");
	process.exit(1);
}
const path = join(piHome, "events.jsonl");

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const OFF = "\x1b[0m";

const seen = new Set();
let offset = 0;

function stamp() {
	return `${DIM}${new Date().toTimeString().slice(0, 8)}${OFF}`;
}

function emit(tag, colour, body) {
	if (!body) return;
	const key = `${tag}:${body.slice(0, 160)}`;
	if (seen.has(key)) return;
	seen.add(key);
	const text = body.replace(/\s+/g, " ").trim();
	console.log(`${stamp()} ${colour}${tag}${OFF} ${text.slice(0, 600)}`);
}

function handle(event) {
	const type = event?.type;
	if (type === "extension_ui_request") {
		const message = String(event.message ?? event.title ?? "");
		if (event.method === "notify") emit("note", YELLOW, message);
		else emit("ASK", `${BOLD}${RED}`, `${event.method}: ${message}`);
		return;
	}
	// Only terminal messages: streaming re-sends a growing partial otherwise.
	if (type !== "message_end") return;
	const content = event?.message?.content;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (block.type === "thinking") emit("think", DIM, block.thinking);
		else if (block.type === "text") emit("say", CYAN, block.text);
		else if (block.type === "tool_use") {
			const input = JSON.stringify(block.input ?? {});
			emit("tool", GREEN, `${block.name} ${input.slice(0, 200)}`);
		}
	}
}

function pump() {
	if (!existsSync(path)) return;
	const size = statSync(path).size;
	if (size <= offset) return;
	const chunk = readFileSync(path, "utf8").slice(offset);
	offset = size;
	for (const line of chunk.split("\n")) {
		if (!line.trim()) continue;
		try {
			handle(JSON.parse(line));
		} catch {
			// A torn final line reappears whole on the next pass.
			offset -= line.length;
			break;
		}
	}
}

console.log(`${BOLD}watching${OFF} ${path}`);
setInterval(pump, 1500);
pump();
