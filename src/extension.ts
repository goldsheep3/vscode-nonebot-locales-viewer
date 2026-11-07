// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

const yaml: { load(source: string): unknown } = require('js-yaml');
type LocaleData = Record<string, unknown>;
type DisplayMode = 'inline' | 'after';
type PythonStatics = { assignments: Map<string, string>; imports: Map<string, string> };
const LANGUAGE_ALIASES: Record<string, string> = {
	zh: 'zh_CN', zh_CN: 'zh_CN', zh_Hans: 'zh_CN', en: 'en_US', en_US: 'en_US',
	ja: 'ja', ja_JP: 'ja', ko: 'ko', ko_KR: 'ko', ru: 'ru', ru_RU: 'ru',
};

class LocalePreviewManager implements vscode.Disposable {
	private readonly inlineDecoration = vscode.window.createTextEditorDecorationType({ textDecoration: 'none; display: none;' });
	private readonly afterDecoration = vscode.window.createTextEditorDecorationType({});
	private readonly languageStatus = vscode.window.createStatusBarItem('nonebotLocalesViewer.language', vscode.StatusBarAlignment.Right, 100);
	private readonly disposables: vscode.Disposable[] = [];
	private readonly detectedLocaleDirectories = new Map<string, string | undefined>();
	private readonly localeCache = new Map<string, { mtimeMs: number; data: LocaleData }>();
	private refreshTimer: NodeJS.Timeout | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.languageStatus.command = 'nonebotLocalesViewer.selectLanguage';
		this.languageStatus.tooltip = 'NoneBot2 Locales Viewer: Select preview language';
		const watcher = vscode.workspace.createFileSystemWatcher('**/*.{yaml,yml}');
		this.disposables.push(
			watcher,
			watcher.onDidChange(() => { this.clearLocaleCache(); this.scheduleRefresh(); }),
			watcher.onDidCreate(() => { this.clearLocaleCache(); this.scheduleRefresh(); }),
			watcher.onDidDelete(() => { this.clearLocaleCache(); this.scheduleRefresh(); }),
			vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
			vscode.window.onDidChangeTextEditorVisibleRanges(() => this.scheduleRefresh()),
			vscode.window.onDidChangeTextEditorSelection((event) => this.updateEditor(event.textEditor)),
			vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event)),
			vscode.workspace.onDidSaveTextDocument((document) => {
				if (document.languageId === 'python') {this.detectedLocaleDirectories.clear(); this.scheduleRefresh();}
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('nonebotLocalesViewer')) {this.detectedLocaleDirectories.clear(); this.clearLocaleCache(); this.scheduleRefresh();}
			}),
		);
	}

	refresh(): void { for (const editor of vscode.window.visibleTextEditors) {this.updateEditor(editor);} this.updateLanguageStatus(vscode.window.activeTextEditor); }
	scheduleRefresh(): void {
		if (this.refreshTimer) {clearTimeout(this.refreshTimer);}
		this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; this.refresh(); }, 200);
	}
	private clearLocaleCache(): void { this.localeCache.clear(); }
	private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
		if (event.document.languageId === 'python' || /\.ya?ml$/i.test(event.document.fileName)) {this.scheduleRefresh();}
	}

	private updateEditor(editor: vscode.TextEditor): void {
		if (editor.document.languageId !== 'python') { editor.setDecorations(this.inlineDecoration, []); editor.setDecorations(this.afterDecoration, []); return; }
		const config = vscode.workspace.getConfiguration('nonebotLocalesViewer', editor.document.uri);
		const mode = config.get<DisplayMode>('displayMode', 'inline');
		const previewColor = config.get<string>('previewColor', '').trim() || 'var(--vscode-debugTokenExpression-string)';
		const locale = this.loadLocale(editor.document, config);
		const decorations = this.findKeys(editor.document, config.get<string[]>('replyFunctions', ['reply'])).flatMap(({ range, key }) => {
			if (mode === 'inline' && range.intersection(editor.selection)) {return [];}
			const text = this.lookup(locale, key) ?? 'NO TRANSLATION!!!';
			const preview = `⋘${text}⋙`;
			return [{ range, hoverMessage: new vscode.MarkdownString(`**Locale key:** \`${key}\`\n\n**Preview:** ${text}`), renderOptions: mode === 'inline' ? { before: { contentText: preview, color: previewColor } } : { after: { contentText: `  ← ${preview}`, color: previewColor } } }];
		});
		editor.setDecorations(this.inlineDecoration, mode === 'inline' ? decorations : []);
		editor.setDecorations(this.afterDecoration, mode === 'after' ? decorations : []);
	}

	async selectLanguage(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const details = editor && this.getLocaleDetails(editor.document);
		if (!details) {vscode.window.showInformationMessage('NoneBot2 Locales Viewer: no language directory was found for the active file.'); return;}
		const languages = this.availableLanguages(details.directory);
		if (languages.length === 0) {vscode.window.showInformationMessage('NoneBot2 Locales Viewer: no YAML language files were found.'); return;}
		const selected = this.selectedLanguage(details.directory, details.config);
		const choice = await vscode.window.showQuickPick(languages.map((language) => ({ label: language, picked: language === selected })), { placeHolder: 'Select preview language' });
		if (!choice) {return;}
		await this.context.workspaceState.update(this.languageStateKey(details.directory), choice.label);
		this.refresh();
	}

	private updateLanguageStatus(editor: vscode.TextEditor | undefined): void {
		const details = editor && this.getLocaleDetails(editor.document);
		if (!details || this.availableLanguages(details.directory).length === 0) {this.languageStatus.hide(); return;}
		const language = this.selectedLanguage(details.directory, details.config);
		this.languageStatus.text = `$(globe) ${language}`;
		this.languageStatus.tooltip = `NoneBot2 Locales Viewer\n${details.directory}\nClick to select preview language`;
		this.languageStatus.show();
	}

	private loadLocale(document: vscode.TextDocument, config: vscode.WorkspaceConfiguration): LocaleData {
		const details = this.getLocaleDetails(document, config);
		return details ? this.readLocale(details.directory, this.selectedLanguage(details.directory, details.config)) : {};
	}
	private getLocaleDetails(document: vscode.TextDocument, config = vscode.workspace.getConfiguration('nonebotLocalesViewer', document.uri)): { directory: string; config: vscode.WorkspaceConfiguration } | undefined {
		if (document.languageId !== 'python') {return undefined;}
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
		if (!workspaceFolder) {return undefined;}
		return { directory: this.resolveLocaleDirectory(document.uri.fsPath, workspaceFolder, config), config };
	}
	private selectedLanguage(directory: string, config: vscode.WorkspaceConfiguration): string {
		return this.context.workspaceState.get<string>(this.languageStateKey(directory)) ?? config.get<string>('language', 'zh_CN');
	}
	private languageStateKey(directory: string): string {return `language:${path.normalize(directory).toLowerCase()}`;}
	private availableLanguages(directory: string): string[] {
		try {return fs.readdirSync(directory).filter((name) => /\.ya?ml$/i.test(name)).map((name) => path.parse(name).name).sort();}
		catch {return [];}
	}
	private resolveLocaleDirectory(file: string, workspaceFolder: string, config: vscode.WorkspaceConfiguration): string {
		const configured = config.get<string>('localeDirectory', '').trim();
		if (configured) {return path.resolve(workspaceFolder, configured);}
		return this.detectLocaleDirectory(file, workspaceFolder) ?? path.join(workspaceFolder, 'assets', 'lang');
	}
	private detectLocaleDirectory(file: string, workspaceFolder: string): string | undefined {
		const cacheKey = `${workspaceFolder}\0${file}`;
		if (this.detectedLocaleDirectories.has(cacheKey)) {return this.detectedLocaleDirectories.get(cacheKey);}
		const detected = this.detectLocaleDirectoryNearFile(file, workspaceFolder) ?? this.detectLocaleDirectoryInWorkspace(file, workspaceFolder);
		this.detectedLocaleDirectories.set(cacheKey, detected);
		return detected;
	}
	private detectLocaleDirectoryNearFile(file: string, workspaceFolder: string): string | undefined {
		let directory = path.dirname(file);
		while (isPathInside(directory, workspaceFolder)) {
			const files = this.pythonFilesIn(directory, file);
			for (const candidate of files) {
				const localeDirectory = this.detectLocaleDirectoryInFile(candidate);
				if (localeDirectory) {return localeDirectory;}
			}
			if (path.relative(workspaceFolder, directory) === '') {break;}
			directory = path.dirname(directory);
		}
		return undefined;
	}
	private detectLocaleDirectoryInWorkspace(file: string, workspaceFolder: string): string | undefined {
		const candidates = walkPythonFiles(workspaceFolder)
			.flatMap((candidate) => {
				const directory = this.detectLocaleDirectoryInFile(candidate);
				return directory ? [{ file: candidate, directory }] : [];
			})
			.sort((left, right) => comparePathProximity(file, left.file, right.file));
		return candidates[0]?.directory;
	}
	private pythonFilesIn(directory: string, currentFile: string): string[] {
		try {
			const files = fs.readdirSync(directory, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith('.py'))
				.map((entry) => path.join(directory, entry.name));
			return files.sort((left, right) => Number(right === currentFile) - Number(left === currentFile));
		} catch { return []; }
	}
	private detectLocaleDirectoryInFile(file: string): string | undefined {
		try {
			const source = fs.readFileSync(file, 'utf8');
			const statics = readPythonStatics(source, file);
			for (const argumentsText of findPythonCallArguments(source, 'locales_init')) {
				const expression = firstPythonArgument(argumentsText).replace(/^lang_dir\s*=\s*/, '');
				const directory = resolveStaticPath(expression, file, statics, new Set());
				if (directory && hasLocaleFiles(directory)) {return directory;}
			}
		} catch { /* unreadable Python files are ignored */ }
		return undefined;
	}
	private readLocale(directory: string, language: string): LocaleData {
		const normalized = language.replace('-', '_');
		const bases = [...new Set([normalized, LANGUAGE_ALIASES[normalized]].filter((value): value is string => Boolean(value)))];
		for (const base of bases) {
			for (const extension of ['.yaml', '.yml']) {
				const file = path.join(directory, `${base}${extension}`);
				let mtimeMs: number;
				try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
				const cached = this.localeCache.get(file);
				if (cached && cached.mtimeMs === mtimeMs) {return cached.data;}
				try {
					const value = yaml.load(fs.readFileSync(file, 'utf8'));
					if (value && typeof value === 'object' && !Array.isArray(value)) {
						const data = value as LocaleData;
						this.localeCache.set(file, { mtimeMs, data });
						return data;
					}
				} catch { /* locale may not exist */ }
			}
		}
		return {};
	}
	private findKeys(document: vscode.TextDocument, functions: string[]): Array<{ range: vscode.Range; key: string }> {
		const names = functions.filter(Boolean).map(escapeRegExp).join('|'); if (!names) {return [];}
		const expression = new RegExp(`\\b(?:${names})\\s*\\(\\s*(['\"])((?:\\\\.|(?!\\1).)*)\\1`, 'g');
		return [...document.getText().matchAll(expression)].flatMap((match) => { const key = match[2]; if (!key || key.includes('\\')) {return [];} const offset = (match.index ?? 0) + match[0].lastIndexOf(key); return [{ key, range: new vscode.Range(document.positionAt(offset), document.positionAt(offset + key.length)) }]; });
	}
	private lookup(locale: LocaleData, key: string): string | undefined {
		let value: unknown = locale;
		for (const part of key.split('.')) { if (!value || typeof value !== 'object' || Array.isArray(value) || !(part in value)) { value = undefined; break; } value = (value as LocaleData)[part]; }
		if (typeof value === 'string') {return value;}
		if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {return value[0];}
		return undefined;
	}
	dispose(): void { if (this.refreshTimer) {clearTimeout(this.refreshTimer); this.refreshTimer = undefined;} this.inlineDecoration.dispose(); this.afterDecoration.dispose(); this.languageStatus.dispose(); for (const disposable of this.disposables) {disposable.dispose();} }
}

function findPythonCallArguments(source: string, functionName: string): string[] {
	const result: string[] = [];
	const name = new RegExp(`\\b${escapeRegExp(functionName)}\\b`, 'g');
	for (const match of source.matchAll(name)) {
		let start = (match.index ?? 0) + functionName.length;
		while (/\s/.test(source[start] ?? '')) {start += 1;}
		if (source[start] !== '(') {continue;}
		const end = findClosingParenthesis(source, start);
		if (end !== undefined) {result.push(source.slice(start + 1, end));}
	}
	return result;
}

function findClosingParenthesis(source: string, start: number): number | undefined {
	let depth = 0;
	let quote: string | undefined;
	for (let index = start; index < source.length; index += 1) {
		const character = source[index];
		if (quote) {
			if (character === '\\') {index += 1;}
			else if (character === quote) {quote = undefined;}
			continue;
		}
		if (character === '\'' || character === '"') {quote = character; continue;}
		if (character === '(') {depth += 1;}
		if (character === ')') {depth -= 1; if (depth === 0) {return index;}}
	}
	return undefined;
}

function firstPythonArgument(argumentsText: string): string {
	let depth = 0;
	let quote: string | undefined;
	for (let index = 0; index < argumentsText.length; index += 1) {
		const character = argumentsText[index];
		if (quote) {
			if (character === '\\') {index += 1;}
			else if (character === quote) {quote = undefined;}
			continue;
		}
		if (character === '\'' || character === '"') {quote = character; continue;}
		if (character === '(' || character === '[' || character === '{') {depth += 1;}
		if (character === ')' || character === ']' || character === '}') {depth -= 1;}
		if (character === ',' && depth === 0) {return argumentsText.slice(0, index).trim();}
	}
	return argumentsText.trim();
}

function readPythonStatics(source: string, file: string): PythonStatics {
	const assignments = new Map([...source.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/gm)].map((match) => [match[1], match[2]]));
	const imports = new Map<string, string>();
	for (const match of source.matchAll(/^\s*from\s+([.\w]+)\s+import\s+(.+?)\s*$/gm)) {
		const importedFile = resolvePythonModule(file, match[1]);
		if (!importedFile) {continue;}
		for (const importedName of match[2].split(',')) {
			const [name, alias] = importedName.trim().split(/\s+as\s+/);
			if (/^[A-Za-z_]\w*$/.test(name)) {imports.set(alias ?? name, importedFile);}
		}
	}
	return { assignments, imports };
}

function resolvePythonModule(file: string, moduleName: string): string | undefined {
	const dots = moduleName.match(/^\.+/)?.[0].length ?? 0;
	let directory = path.dirname(file);
	for (let index = 1; index < dots; index += 1) {directory = path.dirname(directory);}
	const suffix = moduleName.slice(dots).split('.').filter(Boolean);
	const modulePath = path.join(directory, ...suffix);
	for (const candidate of [`${modulePath}.py`, path.join(modulePath, '__init__.py')]) {
		if (fs.existsSync(candidate)) {return candidate;}
	}
	return undefined;
}

function resolveStaticPath(expression: string, file: string, statics: PythonStatics, resolving: Set<string>): string | undefined {
	const variable = expression.trim().match(/^([A-Za-z_]\w*)$/)?.[1];
	const resolvingKey = variable && `${file}\0${variable}`;
	if (variable && resolvingKey && !resolving.has(resolvingKey)) {
		resolving.add(resolvingKey);
		const localExpression = statics.assignments.get(variable);
		const importedFile = statics.imports.get(variable);
		let resolved: string | undefined;
		if (localExpression) {resolved = resolveStaticPath(localExpression, file, statics, resolving);}
		else if (importedFile) {
			try {
				const importedStatics = readPythonStatics(fs.readFileSync(importedFile, 'utf8'), importedFile);
				resolved = resolveStaticPath(variable, importedFile, importedStatics, resolving);
			} catch { /* inaccessible imported modules are ignored */ }
		}
		resolving.delete(resolvingKey);
		return resolved;
	}
	const literal = readPythonString(expression.trim());
	if (literal !== undefined) {return path.resolve(path.dirname(file), literal);}
	const joinedPath = expression.trim().match(/^([A-Za-z_]\w*)\s*\/\s*(['"])(.*?)\2$/s);
	if (joinedPath && !joinedPath[3].includes('\\')) {
		const parent = resolveStaticPath(joinedPath[1], file, statics, resolving);
		return parent ? path.join(parent, joinedPath[3]) : undefined;
	}
	const pathExpression = expression.trim().match(/^Path\(\s*(__file__|(['"])(.*?)\2)\s*\)(.*)$/s);
	if (!pathExpression) {return undefined;}
	let resolved = pathExpression[1] === '__file__' ? file : path.resolve(path.dirname(file), pathExpression[3]);
	let suffix = pathExpression[4].trim();
	while (suffix) {
		if (suffix.startsWith('.parent')) {resolved = path.dirname(resolved); suffix = suffix.slice('.parent'.length).trim(); continue;}
		const child = suffix.match(/^\/\s*(['"])(.*?)\1(.*)$/s);
		if (!child || child[2].includes('\\')) {return undefined;}
		resolved = path.join(resolved, child[2]);
		suffix = child[3].trim();
	}
	return resolved;
}

function readPythonString(value: string): string | undefined {
	const match = value.match(/^(['"])(.*?)\1$/s);
	return match && !match[2].includes('\\') ? match[2] : undefined;
}

function hasLocaleFiles(directory: string): boolean {
	try {return fs.statSync(directory).isDirectory() && fs.readdirSync(directory).some((name) => /\.ya?ml$/i.test(name));}
	catch {return false;}
}

function walkPythonFiles(root: string): string[] {
	const result: string[] = [];
	const ignoredDirectories = new Set(['.git', '.hg', '.svn', '.venv', 'venv', 'node_modules', '__pycache__']);
	const pending = [root];
	while (pending.length > 0 && result.length < 800) {
		const directory = pending.pop()!;
		try {
			for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
				const entryPath = path.join(directory, entry.name);
				if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {pending.push(entryPath);}
				else if (entry.isFile() && entry.name.endsWith('.py')) {result.push(entryPath);}
			}
		} catch { /* inaccessible directories are ignored */ }
	}
	return result;
}

function comparePathProximity(currentFile: string, leftFile: string, rightFile: string): number {
	const current = path.dirname(currentFile).split(path.sep);
	const score = (candidate: string): [number, number] => {
		const parts = path.dirname(candidate).split(path.sep);
		let shared = 0;
		while (shared < current.length && shared < parts.length && current[shared].toLowerCase() === parts[shared].toLowerCase()) {shared += 1;}
		return [shared, Math.abs(current.length - parts.length)];
	};
	const [leftShared, leftDistance] = score(leftFile);
	const [rightShared, rightDistance] = score(rightFile);
	return rightShared - leftShared || leftDistance - rightDistance || leftFile.localeCompare(rightFile);
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function isPathInside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	if (relative === '') {return true;}
	return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	const previews = new LocalePreviewManager(context);
	context.subscriptions.push(previews, vscode.commands.registerCommand('nonebotLocalesViewer.refresh', () => previews.refresh()), vscode.commands.registerCommand('nonebotLocalesViewer.selectLanguage', () => previews.selectLanguage()));
	previews.refresh();
}

// This method is called when your extension is deactivated
export function deactivate() {}
