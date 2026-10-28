#!/usr/bin/env bun
// Bounded JSONL Pi-auth adapter uses version-gated auth storage locks.
// ModelRuntime resolves/refreshes OAuth; no extensions load in this Worker.
// Register Recurse Anthropic OAuth so Settings refresh uses api.anthropic.com.
// Failed refresh never leaks response bodies, regardless of PI_RECURSE.

import { chmodSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline";

const EXPECTED_PI_VERSION = "1.3.0";
const ANTHROPIC_OAUTH_MODULE = new URL(
	"./auth/anthropic_oauth.ts", import.meta.url).href;
const MAX_INPUT_CHARS = 64 * 1024;
// Login-owned routes include Muse's minted key; unknown IDs fail closed.
const ALLOWED_PROVIDERS = new Set([
	"anthropic", "openai-codex", "openai", "openrouter",
	"muse-code",
]);

function emit(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function packageEntry() {
	const root = process.env.RECURSE_PI_PACKAGE_ROOT;
	if (!root) throw new Error("package_unavailable");
	const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	const entry = manifest?.exports?.["."]?.import;
	if (manifest?.name !== "@earendil-works/pi-coding-agent"
		|| manifest?.version !== EXPECTED_PI_VERSION || typeof entry !== "string") {
		throw new Error("package_mismatch");
	}
	const path = resolve(root, entry);
	if (!path.startsWith(`${resolve(root)}/`)) throw new Error("package_mismatch");
	return path;
}

// The file-backed lock is no longer re-exported from the package entry, but the
// version gate above pins the exact dist layout this relative path assumes.
function storageBackend(root) {
	const path = resolve(root, "dist/core/auth-storage.js");
	if (!path.startsWith(`${resolve(root)}/`)) {
		throw new Error("package_mismatch");
	}
	return path;
}

function provider(value, extra) {
	if (typeof value !== "string") throw new Error("invalid_input");
	if (ALLOWED_PROVIDERS.has(value)) return value;
	
	if (extra instanceof Set && extra.has(value)) return value;
	throw new Error("invalid_input");
}

// Custom endpoint IDs are validated JSON keys, never paths.
const CUSTOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;

function extraProviders(request) {
	const extra = new Set();
	const list = request.custom_providers;
	if (!Array.isArray(list)) return extra;
	for (const id of list) {
		if (typeof id === "string" && CUSTOM_ID_RE.test(id)) extra.add(id);
	}
	return extra;
}

function validCredential(credential) {
	if (credential === null || typeof credential !== "object"
		|| Array.isArray(credential) || typeof credential.type !== "string") {
		return false;
	}
	// Invariant: Fail closed on unusable selections: a partial credential must
	// error rather than resolve, so ambient fallbacks can never override it.
	if (credential.type === "oauth") {
		return typeof credential.access === "string" && credential.access.length > 0
			&& typeof credential.refresh === "string" && credential.refresh.length > 0
			&& typeof credential.expires === "number" && Number.isFinite(credential.expires);
	}
	if (credential.type === "api_key") {
		return (typeof credential.key === "string" && credential.key.length > 0)
			|| (credential.env !== null && typeof credential.env === "object"
				&& Object.keys(credential.env).length > 0);
	}
	return false;
}

function validCredentials(data) {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return false;
	}
	return Object.values(data).every(validCredential);
}

function parseCredentials(current) {
	let data;
	try {
		data = current ? JSON.parse(current) : {};
	} catch {
		throw new Error("operation_failed");
	}
	if (!validCredentials(data)) throw new Error("operation_failed");
	return data;
}

function mutate(FileAuthStorageBackend, authPath, remove, selected, onlyIfMissing = false) {
	const backend = new FileAuthStorageBackend(authPath);
	return backend.withLock((current) => {
		const data = parseCredentials(current);
		// Invariant: ChatGPT subscription and OpenAI API-key credentials are one
		// mutually exclusive Settings route; never let ambient Codex import win a
		// race with selecting the direct OpenAI route.
		if (selected && onlyIfMissing && (
			selected.provider in data
			|| (selected.provider === "openai-codex" && "openai" in data)
		)) {
			return { result: false };
		}
		for (const id of remove) delete data[id];
		if (selected) data[selected.provider] = selected.credential;
		return { result: true, next: `${JSON.stringify(data, null, 2)}\n` };
	});
}

function seedMissing(FileAuthStorageBackend, authPath, seed) {
	if (existsSync(authPath) || typeof seed !== "string" || !seed) return false;
	let parsed;
	try {
		parsed = JSON.parse(seed);
	} catch {
		throw new Error("operation_failed");
	}
	if (!validCredentials(parsed)) throw new Error("operation_failed");
	const seeded = `${JSON.stringify(parsed, null, 2)}\n`;
	const backend = new FileAuthStorageBackend(authPath);
	return backend.withLock((current) => {
		const existing = parseCredentials(current);
		if (Object.keys(existing).length) return { result: false };
		return { result: true, next: seeded };
	});
}

// Same extraction the pi CLI's credential print uses: the resolved API key, or
// the Bearer token from the resolved Authorization header.
function resolvedValue(auth) {
	if (auth?.auth?.apiKey) return auth.auth.apiKey;
	const authorization = Object.entries(auth?.auth?.headers ?? {})
		.find(([name]) => name.toLowerCase() === "authorization")?.[1];
	return typeof authorization === "string"
		? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
}

function modelsPathFor(authPath) {
	return resolve(dirname(authPath), "models.json");
}

function readStoredCredentialFrom(authPath, providerId) {
	try {
		return JSON.parse(readFileSync(authPath, "utf8"))?.[providerId];
	} catch {
		return undefined;
	}
}

async function makeRuntime(imported, authPath) {
	if (typeof imported.ModelRuntime?.create !== "function"
		|| typeof imported.readStoredCredential !== "function") {
		throw new Error("package_mismatch");
	}
	// Invariant: Static catalogs only: the worker never refreshes model
	// availability over the network, and getAuth still refreshes/persists OAuth
	// through the normal request-auth path.
	return imported.ModelRuntime.create({
		authPath,
		modelsPath: modelsPathFor(authPath),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

const THINKING_LEVEL_NAMES = new Set([
	"off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Read model reasoning via Pi's own installed pi-ai, never Bun's global cache.
// This unexported API fails soft; absent/invalid results omit reasoning levels
// and report why, without failing the model list.
function piAiEntry(root) {
	const real = realpathSync(root);
	for (const dir of [resolve(real, "node_modules/@earendil-works/pi-ai"),
		resolve(dirname(real), "pi-ai")]) {
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
		} catch {
			continue;
		}
		const entry = manifest?.exports?.["."]?.import;
		if (manifest?.name !== "@earendil-works/pi-ai"
			|| manifest?.version !== EXPECTED_PI_VERSION
			|| typeof entry !== "string") continue;
		const path = resolve(dir, entry);
		if (path.startsWith(`${dir}/`)) return path;
	}
	return null;
}

async function thinkingLevelsReader(root) {
	let path;
	try {
		path = piAiEntry(root);
	} catch {
		path = null;
	}
	if (path === null) return { unavailable: "pi_ai_unresolved" };
	let piAi;
	try {
		piAi = await import(pathToFileURL(path).href);
	} catch {
		return { unavailable: "pi_ai_import_failed" };
	}
	if (typeof piAi.getSupportedThinkingLevels !== "function") {
		return { unavailable: "reasoning_levels_function_missing" };
	}
	return { read: piAi.getSupportedThinkingLevels };
}

function modelReasoningLevels(read, model) {
	const levels = read(model);
	if (!Array.isArray(levels) || !levels.length
		|| levels.some((level) => !THINKING_LEVEL_NAMES.has(level))) {
		throw new Error("invalid thinking levels");
	}
	return [...new Set(levels)];
}

// Share the Durable OAuth implementation; only resolve_anthropic refreshes.
async function useRecurseAnthropicOAuth(runtime) {
	if (typeof runtime.registerProvider !== "function"
		|| typeof runtime.refresh !== "function") {
		throw new Error("package_mismatch");
	}
	const { anthropicOAuth } = await import(ANTHROPIC_OAUTH_MODULE);
	runtime.registerProvider("anthropic", { oauth: anthropicOAuth });
	await runtime.refresh({ allowNetwork: false });
}

async function main(request, root, imported, FileAuthStorageBackend) {
	if (imported.VERSION !== EXPECTED_PI_VERSION) {
		throw new Error("package_mismatch");
	}
	const authPath = process.env.RECURSE_PI_AUTH_PATH;
	if (!authPath) throw new Error("invalid_input");
	// Invariant: Pi writes auth.json in place and applies mode 0600 only when it
	// creates the file, so an existing wider file would keep its mode across every
	// login and refresh. Restrict it before any action can write to it.
	if (existsSync(authPath)) chmodSync(authPath, 0o600);
	if (request.action === "seed") {
		emit({ kind: "complete", changed: seedMissing(
			FileAuthStorageBackend, authPath, request.seed) });
		return;
	}

	// Spec: list_models reads bundled/stored Pi catalogs without network.
	// update:true fetches logged-in providers from pi.dev without credentials,
	// bounded to 15s; failed providers retain catalogs and report errors.
	if (request.action === "list_models") {
		const ids = request.providers;
		if (!Array.isArray(ids) || ids.length > 16
			|| ids.some((id) => !ALLOWED_PROVIDERS.has(id))
			|| (request.update !== undefined && typeof request.update !== "boolean")) {
			throw new Error("invalid_input");
		}
		const runtime = await makeRuntime(imported, authPath);
		if (typeof runtime.refresh !== "function"
			|| typeof runtime.getModels !== "function") {
			throw new Error("package_mismatch");
		}
		const errors = [];
		if (request.update === true) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 15_000);
			try {
				const result = await runtime.refresh({ allowNetwork: true,
					force: true, signal: controller.signal });
				if (result?.aborted) {
					errors.push({ provider: "", message: "timed out after 15 s" });
				}
				for (const [provider, error] of result?.errors ?? []) {
					errors.push({ provider: String(provider).slice(0, 64),
						message: String(error?.message ?? error)
							.replace(/[\u0000-\u001f\u007f]+/gu, " ").slice(0, 200) });
				}
			} finally {
				clearTimeout(timer);
			}
		}
		await runtime.refresh({ allowNetwork: false });
		const levels = await thinkingLevelsReader(root);
		let levelsUnavailable = levels.unavailable;
		const models = [];
		for (const id of ids) {
			for (const model of runtime.getModels(id)) {
				if (typeof model?.id !== "string" || !model.id
					|| !Number.isSafeInteger(model.contextWindow)
					|| model.contextWindow <= 0) continue;
				models.push({ provider: id, id: model.id,
					name: typeof model.name === "string" && model.name
						? model.name : model.id,
					context_window: model.contextWindow });
				if (!levels.read) continue;
				try {
					models.at(-1).reasoning_levels = modelReasoningLevels(
						levels.read, model);
				} catch {
					levelsUnavailable ??= "reasoning_levels_failed";
				}
			}
		}
		emit({ kind: "models", models, errors: errors.slice(0, 16),
			...(levelsUnavailable
				? { reasoning_levels_unavailable: levelsUnavailable } : {}) });
		return;
	}

	if (request.action === "replace") {
		const extra = extraProviders(request);
		const remove = Array.isArray(request.remove)
			? request.remove.map((id) => provider(id, extra)) : [];
		const id = provider(request.provider, extra);
		const credential = request.credential;
		if (!validCredentials({ [id]: credential })) {
			throw new Error("invalid_input");
		}
		const changed = mutate(
			FileAuthStorageBackend, authPath, remove,
			{ provider: id, credential }, request.only_if_missing === true,
		);
		emit({ kind: "complete", changed });
		return;
	}
	if (request.action === "remove") {
		const extra = extraProviders(request);
		const remove = Array.isArray(request.providers)
			? request.providers.map((id) => provider(id, extra)) : [];
		mutate(FileAuthStorageBackend, authPath, remove, null);
		emit({ kind: "complete" });
		return;
	}
	if (request.action !== "resolve_anthropic") throw new Error("invalid_input");
	if (!existsSync(authPath)) {
		emit({ kind: "credential", selected: false, changed: false });
		return;
	}
	// Invariant: A missing selection inside a readable store is a completed
	// no-selection state; an unreadable store is a failure, never an ambient
	// fallback.
	let store;
	try {
		store = JSON.parse(readFileSync(authPath, "utf8"));
	} catch {
		throw new Error("operation_failed");
	}
	if (!store || typeof store !== "object" || Array.isArray(store)) {
		throw new Error("operation_failed");
	}
	const before = store.anthropic;
	if (!before) {
		emit({ kind: "credential", selected: false, changed: false });
		return;
	}
	if (!validCredential(before)) throw new Error("operation_failed");
	const runtime = await makeRuntime(imported, authPath);
	await useRecurseAnthropicOAuth(runtime);
	const auth = await runtime.getAuth("anthropic");
	const value = resolvedValue(auth);
	const credential = readStoredCredentialFrom(authPath, "anthropic");
	if (!value || (credential?.type !== "oauth" && credential?.type !== "api_key")) {
		throw new Error("operation_failed");
	}
	emit({ kind: "credential", selected: true,
		credential_type: credential.type, value,
		changed: JSON.stringify(before) !== JSON.stringify(credential) });
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
	const line = await lines[Symbol.asyncIterator]().next();
	if (line.done || typeof line.value !== "string" || line.value.length > MAX_INPUT_CHARS) {
		throw new Error("invalid_input");
	}
	let request;
	try {
		request = JSON.parse(line.value);
	} catch {
		throw new Error("invalid_input");
	}
	if (!request || typeof request !== "object" || Array.isArray(request)) {
		throw new Error("invalid_input");
	}
	const root = process.env.RECURSE_PI_PACKAGE_ROOT;
	if (!root) throw new Error("package_unavailable");
	const imported = await import(pathToFileURL(packageEntry()).href);
	const storage = await import(pathToFileURL(storageBackend(root)).href);
	if (typeof storage.FileAuthStorageBackend !== "function") {
		throw new Error("package_mismatch");
	}
	await main(request, root, imported, storage.FileAuthStorageBackend);
} catch (error) {
	const safe = new Set(["invalid_input", "package_unavailable", "package_mismatch"]);
	const reason = error instanceof Error && safe.has(error.message)
		? error.message : "operation_failed";
	emit({ kind: "error", reason });
	process.exitCode = 1;
} finally {
	lines.close();
}
