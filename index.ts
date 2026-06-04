import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import YAML from "yaml";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type Outfit = {
	id: string;
	path: string;
	name?: string;
	description?: string;
	thinking?: ThinkingLevel;
	prompt?: string;
	model?: string;
	tools?: string[];
};

type OutfitLoadResult = {
	outfits: Map<string, Outfit>;
	errors: string[];
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const RawOutfitSchema = Type.Object(
	{
		version: Type.Optional(Type.Literal(1)),
		name: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
		hat: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
		prompt: Type.Optional(Type.String()),
		shirt: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		pants: Type.Optional(Type.String()),
		tools: Type.Optional(Type.Array(Type.String())),
		shoes: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

type RawOutfit = Type.Static<typeof RawOutfitSchema>;

const OUTFIT_UI_BACK = "Back";
const OUTFIT_UI_RELOAD = "Reload outfits";

let outfits: Map<string, Outfit> = new Map();
let loadErrors: string[] = [];
let activeOutfitId: string | undefined;
let activeOutfit: Outfit | undefined;
let lastObservedModel: { provider?: string; modelId?: string } = {};
let requestEditorRender: (() => void) | undefined;

function getGlobalOutfitsDir(): string {
	return path.join(os.homedir(), ".agents", "outfits");
}

function getProjectOutfitsDir(cwd: string): string {
	return path.join(cwd, ".agents", "outfits");
}

async function listYamlFiles(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
			.map((entry) => path.join(dir, entry.name))
			.sort((a, b) => a.localeCompare(b));
	} catch (err: any) {
		if (err?.code === "ENOENT") return [];
		throw err;
	}
}

function getOutfitId(filePath: string): string {
	return path.basename(filePath).replace(/\.ya?ml$/i, "");
}

function hasOwn(obj: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function assertNoAliasConflict(raw: RawOutfit, canonical: keyof RawOutfit, alias: keyof RawOutfit, filePath: string): void {
	if (hasOwn(raw, canonical) && hasOwn(raw, alias)) {
		throw new Error(`${filePath}: specify only one of "${String(canonical)}" or "${String(alias)}"`);
	}
}

function normalizeOutfit(id: string, filePath: string, raw: RawOutfit): Outfit {
	assertNoAliasConflict(raw, "thinking", "hat", filePath);
	assertNoAliasConflict(raw, "prompt", "shirt", filePath);
	assertNoAliasConflict(raw, "model", "pants", filePath);
	assertNoAliasConflict(raw, "tools", "shoes", filePath);

	return {
		id,
		path: filePath,
		name: raw.name,
		description: raw.description,
		thinking: raw.thinking ?? raw.hat,
		prompt: raw.prompt ?? raw.shirt,
		model: raw.model ?? raw.pants,
		tools: raw.tools ?? raw.shoes,
	};
}

async function loadOutfitFile(filePath: string): Promise<Outfit> {
	const content = await fs.readFile(filePath, "utf8");
	const parsed = YAML.parse(content) as unknown;
	if (!Check(RawOutfitSchema, parsed)) {
		throw new Error(`${filePath}: does not match pi-outfits schema v1`);
	}
	return normalizeOutfit(getOutfitId(filePath), filePath, parsed);
}

async function loadOutfits(cwd: string): Promise<OutfitLoadResult> {
	const result = new Map<string, Outfit>();
	const errors: string[] = [];

	for (const dir of [getGlobalOutfitsDir(), getProjectOutfitsDir(cwd)]) {
		let files: string[];
		try {
			files = await listYamlFiles(dir);
		} catch (err) {
			errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}

		for (const file of files) {
			try {
				const outfit = await loadOutfitFile(file);
				result.set(outfit.id, outfit);
			} catch (err) {
				errors.push(err instanceof Error ? err.message : String(err));
			}
		}
	}

	return { outfits: result, errors };
}

async function refreshOutfits(ctx: ExtensionContext): Promise<void> {
	const loaded = await loadOutfits(ctx.cwd);
	outfits = loaded.outfits;
	loadErrors = loaded.errors;
	if (activeOutfitId) {
		activeOutfit = outfits.get(activeOutfitId);
		if (!activeOutfit) activeOutfitId = undefined;
	}
	updateStatus(ctx);
}

function displayName(outfit: Outfit): string {
	return outfit.name ? `${outfit.id} (${outfit.name})` : outfit.id;
}

function buildDescription(outfit: Outfit): string {
	const parts: string[] = [];
	if (outfit.model) parts.push(outfit.model);
	if (outfit.thinking) parts.push(`thinking:${outfit.thinking}`);
	if (outfit.tools) parts.push(`tools:${outfit.tools.join(",")}`);
	if (outfit.description) parts.push(outfit.description);
	return parts.join(" | ");
}

function parseModelSelector(selector: string): { provider: string; modelId: string } | undefined {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) return undefined;
	return { provider: selector.slice(0, slash), modelId: selector.slice(slash + 1) };
}

async function applyOutfit(pi: ExtensionAPI, ctx: ExtensionContext, outfitId: string): Promise<void> {
	await refreshOutfits(ctx);
	const outfit = outfits.get(outfitId);
	if (!outfit) {
		const available = Array.from(outfits.keys()).join(", ") || "none defined";
		if (ctx.hasUI) ctx.ui.notify(`Unknown outfit "${outfitId}". Available: ${available}`, "warning");
		return;
	}

	activeOutfitId = outfitId;
	activeOutfit = outfit;

	if (outfit.model) {
		const parsed = parseModelSelector(outfit.model);
		if (!parsed) {
			if (ctx.hasUI) ctx.ui.notify(`Outfit "${outfitId}" has invalid model selector: ${outfit.model}`, "warning");
		} else {
			const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
			if (!model) {
				if (ctx.hasUI) ctx.ui.notify(`Outfit "${outfitId}" references unknown model ${outfit.model}`, "warning");
			} else {
				const ok = await pi.setModel(model);
				if (ok) lastObservedModel = { provider: parsed.provider, modelId: parsed.modelId };
				else if (ctx.hasUI) ctx.ui.notify(`No API key available for ${outfit.model}`, "warning");
			}
		}
	}

	if (outfit.thinking) {
		pi.setThinkingLevel(outfit.thinking);
	}

	applyPinnedTools(pi, ctx);
	persistState(pi);
	updateStatus(ctx, pi.getThinkingLevel());
	if (ctx.hasUI) ctx.ui.notify(`Outfit "${outfitId}" activated`, "info");
}

function applyPinnedTools(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!activeOutfit?.tools) return;

	const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
	const validTools = activeOutfit.tools.filter((tool) => allToolNames.has(tool));
	const invalidTools = activeOutfit.tools.filter((tool) => !allToolNames.has(tool));
	if (invalidTools.length > 0 && ctx.hasUI) {
		ctx.ui.notify(`Outfit "${activeOutfit.id}" references unknown tools: ${invalidTools.join(", ")}`, "warning");
	}
	pi.setActiveTools(validTools);
}

function isRuntimeModelOverride(outfit: Outfit | undefined): boolean {
	if (!outfit?.model || !lastObservedModel.provider || !lastObservedModel.modelId) return false;
	const parsed = parseModelSelector(outfit.model);
	if (!parsed) return false;
	return parsed.provider !== lastObservedModel.provider || parsed.modelId !== lastObservedModel.modelId;
}

function getOutfitLabel(currentThinking?: ThinkingLevel): string | undefined {
	if (!activeOutfitId) return undefined;
	let label = activeOutfitId;
	if (isRuntimeModelOverride(activeOutfit) && lastObservedModel.modelId) {
		label += `[${lastObservedModel.modelId}]`;
	}
	const thinkingIndex = THINKING_LEVELS.indexOf(currentThinking ?? activeOutfit?.thinking ?? "off");
	return `${label}^${thinkingIndex < 0 ? 0 : thinkingIndex}`;
}

function updateStatus(ctx: ExtensionContext, currentThinking?: ThinkingLevel): void {
	if (!ctx.hasUI) return;
	const label = getOutfitLabel(currentThinking);
	ctx.ui.setStatus("outfit", label ? ctx.ui.theme.fg("accent", `outfit:${label}`) : undefined);
	requestEditorRender?.();
}

class OutfitPromptEditor extends CustomEditor {
	public outfitLabelProvider?: () => string | undefined;

	override render(width: number): string[] {
		const lines = super.render(width);
		const outfit = this.outfitLabelProvider?.();
		if (!outfit) return lines;

		const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
		const topPlain = stripAnsi(lines[0] ?? "");
		const scrollPrefixMatch = topPlain.match(/^(─── ↑ \d+ more )/);
		const prefix = scrollPrefixMatch?.[1] ?? "──";
		const labelLeftSpace = prefix.endsWith(" ") ? "" : " ";
		const labelRightSpace = " ";
		const minRightBorder = 1;
		const maxLabelLen = Math.max(0, width - prefix.length - labelLeftSpace.length - labelRightSpace.length - minRightBorder);
		if (maxLabelLen <= 0) return lines;

		const label = outfit.length > maxLabelLen ? outfit.slice(0, maxLabelLen) : outfit;
		const labelChunk = `${labelLeftSpace}${label}${labelRightSpace}`;
		const remaining = width - prefix.length - labelChunk.length;
		if (remaining < 0) return lines;

		lines[0] = this.borderColor(prefix) + this.borderColor(labelChunk) + this.borderColor("─".repeat(Math.max(0, remaining)));
		return lines;
	}

	public requestRenderNow(): void {
		this.tui.requestRender();
	}
}

function applyEditor(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = new OutfitPromptEditor(tui, theme, keybindings);
		requestEditorRender = () => editor.requestRenderNow();
		editor.outfitLabelProvider = () => getOutfitLabel(pi.getThinkingLevel());
		return editor;
	});
}

function persistState(pi: ExtensionAPI): void {
	if (activeOutfitId) {
		pi.appendEntry("outfit-state", { id: activeOutfitId });
	}
}

async function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const branch = ctx.sessionManager.getBranch();
	const entry = branch
		.filter((item: { type: string; customType?: string }) => item.type === "custom" && item.customType === "outfit-state")
		.pop() as { data?: { id?: string } } | undefined;

	const flag = pi.getFlag("outfit");
	const requested = typeof flag === "string" && flag ? flag : entry?.data?.id;
	if (requested) {
		await applyOutfit(pi, ctx, requested);
	}
}

async function selectOutfitUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	await refreshOutfits(ctx);

	while (true) {
		const names = Array.from(outfits.keys()).sort();
		if (names.length === 0) {
			const choice = await ctx.ui.select("No outfits found in ~/.agents/outfits or .agents/outfits", [OUTFIT_UI_RELOAD, OUTFIT_UI_BACK]);
			if (choice === OUTFIT_UI_RELOAD) {
				await refreshOutfits(ctx);
				continue;
			}
			return;
		}

		const options = [...names, OUTFIT_UI_RELOAD, OUTFIT_UI_BACK];
		const choice = await ctx.ui.select(`Outfit${activeOutfitId ? ` (current: ${activeOutfitId})` : ""}`, options);
		if (!choice || choice === OUTFIT_UI_BACK) return;
		if (choice === OUTFIT_UI_RELOAD) {
			await refreshOutfits(ctx);
			continue;
		}
		await applyOutfit(pi, ctx, choice);
		return;
	}
}

export default function outfitsExtension(pi: ExtensionAPI) {
	pi.registerFlag("outfit", {
		description: "Outfit to activate from .agents/outfits",
		type: "string",
	});

	pi.registerCommand("outfit", {
		description: "Select an outfit",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (name === "reload") {
				await refreshOutfits(ctx);
				if (ctx.hasUI) ctx.ui.notify(`Loaded ${outfits.size} outfit(s)`, "info");
				return;
			}

			if (name === "list") {
				await refreshOutfits(ctx);
				if (ctx.hasUI) {
					const summary = Array.from(outfits.values())
						.sort((a, b) => a.id.localeCompare(b.id))
						.map((outfit) => `${displayName(outfit)}${buildDescription(outfit) ? ` - ${buildDescription(outfit)}` : ""}`)
						.join("\n");
					ctx.ui.notify(summary || "No outfits found", "info");
				}
				return;
			}

			if (name) {
				await applyOutfit(pi, ctx, name);
				return;
			}

			await selectOutfitUI(pi, ctx);
		},
	});

	pi.registerShortcut("alt+o", {
		description: "Select outfit",
		handler: async (ctx) => {
			await selectOutfitUI(pi, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		lastObservedModel = { provider: ctx.model?.provider, modelId: ctx.model?.id };
		await refreshOutfits(ctx);
		await restoreState(pi, ctx);
		applyEditor(pi, ctx);
		if (loadErrors.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Outfit load errors:\n${loadErrors.join("\n")}`, "warning");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		await refreshOutfits(ctx);
		await restoreState(pi, ctx);
		applyEditor(pi, ctx);
	});

	pi.on("model_select", async (event: any, ctx) => {
		lastObservedModel = { provider: event.model.provider, modelId: event.model.id };
		updateStatus(ctx, pi.getThinkingLevel());
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		updateStatus(ctx, pi.getThinkingLevel());
	});

	pi.on("turn_start", async (_event, ctx) => {
		applyPinnedTools(pi, ctx);
		persistState(pi);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		applyPinnedTools(pi, ctx);
		if (activeOutfit?.prompt) {
			return { systemPrompt: activeOutfit.prompt };
		}
	});
}
