import type { Answers, Questionnaire } from "@vegardx/pi-contracts";

export interface MaestroPackageCommandContext {
	readonly cwd: string;
	readonly agentDir: string;
	readonly asker?: { ask(questions: Questionnaire): Promise<Answers> };
	readonly notify: (message: string, level: "info" | "warning") => void;
}

/** Shared `/maestro setup|doctor` subcommands owned by the settings command. */
export async function handleMaestroPackageCommand(
	action: "setup" | "doctor",
	context: MaestroPackageCommandContext,
): Promise<void> {
	if (action === "setup") {
		const {
			applyMaestroSetup,
			DEFAULT_MAESTRO_SETUP_PINS,
			formatMaestroSetupPlan,
			planInstalledMaestroSetup,
		} = await import("./setup.js");
		const plan = planInstalledMaestroSetup({
			agentDir: context.agentDir,
			pins: DEFAULT_MAESTRO_SETUP_PINS,
		});
		const summary = formatMaestroSetupPlan(plan);
		if (!plan.requiresConfirmation) {
			context.notify(summary, "info");
			return;
		}
		if (!context.asker) {
			context.notify(
				`${summary}\n\nSetup needs the ask-user-question package so you can approve this settings change.`,
				"warning",
			);
			return;
		}
		const answers = await context.asker.ask([
			{
				id: "maestro-setup",
				header: "Maestro setup",
				question: summary,
				options: [
					{ label: "Yes", value: "yes" },
					{ label: "No", value: "no" },
				],
				blocking: true,
				whyBlocking: "Global Pi package settings require explicit approval.",
			},
		]);
		const answer = answers[0];
		if (
			answer?.source !== "human" ||
			answer.deferred ||
			answer.skipped ||
			answer.value.trim().toLowerCase() !== "yes"
		) {
			context.notify("Maestro setup was not approved.", "warning");
			return;
		}
		applyMaestroSetup({
			cwd: context.cwd,
			agentDir: context.agentDir,
			pins: DEFAULT_MAESTRO_SETUP_PINS,
			confirmed: true,
		});
		context.notify(
			"Maestro package pins were updated. Reload Pi to install or activate them.",
			"info",
		);
		return;
	}

	const { formatMaestroDoctor, runInstalledMaestroDoctor } = await import(
		"./doctor.js"
	);
	const { DEFAULT_MAESTRO_SETUP_PINS } = await import("./setup.js");
	context.notify(
		formatMaestroDoctor(
			runInstalledMaestroDoctor({
				cwd: context.cwd,
				agentDir: context.agentDir,
				pins: DEFAULT_MAESTRO_SETUP_PINS,
			}),
		),
		"info",
	);
}
