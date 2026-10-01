import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { load } from 'cheerio';

const maxImportBytes = 10 * 1024 * 1024;
const blockedExtensions = new Set([
  '.appx', '.bat', '.cmd', '.com', '.dll', '.exe', '.lnk', '.msi', '.msix', '.ps1', '.psm1', '.reg', '.scr', '.sh', '.sys', '.url',
]);

export class LocalCapabilityError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface InstallableApp {
  id: string;
  name: string;
  publisher: string;
  description: string;
}

export interface InstallOperation {
  id: string;
  app: InstallableApp;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAt: string;
  finishedAt?: string;
  output?: string;
  error?: string;
}

export const installableApps: InstallableApp[] = [
  { id: 'Microsoft.VisualStudioCode', name: 'Visual Studio Code', publisher: 'Microsoft', description: 'Edytor kodu i projektów.' },
  { id: 'Git.Git', name: 'Git', publisher: 'Git for Windows', description: 'System kontroli wersji.' },
  { id: '7zip.7zip', name: '7-Zip', publisher: '7-Zip', description: 'Archiwizator plików.' },
  { id: 'VideoLAN.VLC', name: 'VLC media player', publisher: 'VideoLAN', description: 'Odtwarzacz multimediów.' },
  { id: 'Python.Python.3.13', name: 'Python 3.13', publisher: 'Python Software Foundation', description: 'Interpreter języka Python.' },
  { id: 'OpenJS.NodeJS.LTS', name: 'Node.js LTS', publisher: 'OpenJS Foundation', description: 'Runtime JavaScript dla narzędzi developerskich.' },
];

function decodeSearchUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl, 'https://html.duckduckgo.com');
    const target = parsed.hostname.endsWith('duckduckgo.com') ? parsed.searchParams.get('uddg') : undefined;
    const result = target ? new URL(target) : parsed;
    if (result.protocol !== 'http:' && result.protocol !== 'https:') return undefined;
    return result.toString();
  } catch {
    return undefined;
  }
}

export function parseDuckDuckGoResults(html: string, limit = 8): WebSearchResult[] {
  const $ = load(html);
  const results: WebSearchResult[] = [];

  $('.result').each((_index, element) => {
    if (results.length >= limit) return false;
    const result = $(element);
    const anchor = result.find('a.result__a').first();
    const title = anchor.text().trim();
    const rawUrl = anchor.attr('href');
    if (!title || !rawUrl) return;
    const url = decodeSearchUrl(rawUrl);
    if (!url) return;
    const snippet = result.find('.result__snippet').first().text().trim();
    results.push({ title, url, snippet });
  });

  return results;
}

function wingetVersion(): Promise<string | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  return new Promise((resolveVersion) => {
    execFile('winget', ['--version'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolveVersion(error ? undefined : stdout.trim());
    });
  });
}

export class LocalCapabilities {
  private readonly workspaceDir: string;
  private readonly installOperations = new Map<string, InstallOperation>();

  constructor(workspaceDir: string) {
    this.workspaceDir = resolve(workspaceDir);
  }

  async searchWeb(query: string): Promise<{ query: string; provider: string; results: WebSearchResult[] }> {
    const normalized = query.trim();
    if (normalized.length < 2 || normalized.length > 300) {
      throw new LocalCapabilityError(400, 'Search query must contain 2 to 300 characters');
    }

    let response: Response;
    try {
      const url = new URL('https://html.duckduckgo.com/html/');
      url.searchParams.set('q', normalized);
      response = await fetch(url, {
        headers: {
          Accept: 'text/html',
          'User-Agent': 'NexusAI/1.0 (local web search)',
        },
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      throw new LocalCapabilityError(502, error instanceof Error ? error.message : 'Web search request failed');
    }
    if (!response.ok) throw new LocalCapabilityError(502, `Search provider returned HTTP ${response.status}`);

    const html = await response.text();
    return { query: normalized, provider: 'DuckDuckGo', results: parseDuckDuckGoResults(html) };
  }

  async importFile(filenameValue: unknown, contentBase64Value: unknown) {
    if (typeof filenameValue !== 'string' || typeof contentBase64Value !== 'string') {
      throw new LocalCapabilityError(400, 'filename and contentBase64 are required');
    }

    const filename = filenameValue.trim();
    if (!filename || filename !== basename(filename) || /[<>:"|?*\x00-\x1f]/.test(filename) || /[. ]$/.test(filename)) {
      throw new LocalCapabilityError(400, 'Filename must be a plain file name without path segments');
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) {
      throw new LocalCapabilityError(400, 'Filename is reserved by Windows');
    }
    if (blockedExtensions.has(extname(filename).toLowerCase())) {
      throw new LocalCapabilityError(415, 'Executable and installer files cannot be imported');
    }

    const encoded = contentBase64Value;
    if (encoded.length > Math.ceil(maxImportBytes * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new LocalCapabilityError(413, 'File exceeds the 10 MB import limit or has invalid encoding');
    }
    const content = Buffer.from(encoded, 'base64');
    if (content.length > maxImportBytes) throw new LocalCapabilityError(413, 'File exceeds the 10 MB import limit');

    await mkdir(this.workspaceDir, { recursive: true });
    const destination = resolve(join(this.workspaceDir, filename));
    if (!destination.startsWith(`${this.workspaceDir}${sep}`)) throw new LocalCapabilityError(400, 'Invalid import path');

    try {
      await writeFile(destination, content, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new LocalCapabilityError(409, 'A file with this name already exists in the workspace');
      }
      throw error;
    }

    return { filename, bytes: content.length, location: 'workspace' as const };
  }

  async getInstallCatalog() {
    const version = await wingetVersion();
    return {
      supported: process.platform === 'win32',
      packageManager: 'winget',
      available: !!version,
      packageManagerVersion: version,
      requiresConfirmation: true,
      apps: installableApps,
    };
  }

  startInstall(packageId: unknown, confirmed: unknown): InstallOperation {
    if (confirmed !== true) throw new LocalCapabilityError(403, 'Explicit confirmation is required for each installation');
    if (process.platform !== 'win32') throw new LocalCapabilityError(501, 'Software installation is only supported on Windows');
    if (typeof packageId !== 'string') throw new LocalCapabilityError(400, 'packageId is required');

    const app = installableApps.find((item) => item.id === packageId);
    if (!app) throw new LocalCapabilityError(400, 'This package is not in the approved installation catalog');
    if ([...this.installOperations.values()].some((item) => item.app.id === app.id && item.status === 'RUNNING')) {
      throw new LocalCapabilityError(409, 'An installation for this application is already running');
    }

    const operation: InstallOperation = {
      id: randomUUID(),
      app,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    };
    this.installOperations.set(operation.id, operation);

    execFile('winget', [
      'install', '--id', app.id, '--exact', '--silent',
      '--accept-source-agreements', '--accept-package-agreements',
    ], { timeout: 30 * 60 * 1000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      operation.status = error ? 'FAILED' : 'COMPLETED';
      operation.finishedAt = new Date().toISOString();
      operation.output = `${stdout}\n${stderr}`.trim().slice(-8000);
      if (error) operation.error = error.message;
    });

    return operation;
  }

  getInstallOperation(id: string): InstallOperation | undefined {
    return this.installOperations.get(id);
  }
}
