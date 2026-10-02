import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { load } from 'cheerio';
import { ToolRegistry, registerDefaultTools } from './toolRegistry.ts';

const maxImportBytes = 10 * 1024 * 1024;
const blockedExtensions = new Set([
  '.appx', '.bat', '.cmd', '.com', '.dll', '.exe', '.lnk', '.msi', '.msix', '.ps1', '.psm1', '.reg', '.scr', '.sh', '.sys', '.url',
]);
const readableExtensions = new Set(['.cjs', '.css', '.html', '.java', '.js', '.jsx', '.json', '.md', '.mjs', '.py', '.rs', '.sql', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml']);
const maxReadableFileBytes = 128 * 1024;

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

export interface WeatherResult {
  provider: 'Open-Meteo';
  location: {
    name: string;
    country?: string;
    latitude: number;
    longitude: number;
    timezone?: string;
  };
  current: {
    temperatureC?: number;
    apparentTemperatureC?: number;
    humidityPercent?: number;
    windKmh?: number;
    weatherCode?: number;
    description: string;
    time?: string;
  };
  daily: Array<{
    date: string;
    minC?: number;
    maxC?: number;
    precipitationProbabilityPercent?: number;
    weatherCode?: number;
    description: string;
  }>;
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

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function weatherCodeDescription(code?: number): string {
  if (code === undefined) return 'brak danych';
  if (code === 0) return 'bezchmurnie';
  if (code === 1) return 'przeważnie bezchmurnie';
  if (code === 2) return 'częściowe zachmurzenie';
  if (code === 3) return 'pochmurno';
  if (code === 45 || code === 48) return 'mgła';
  if ([51, 53, 55, 56, 57].includes(code)) return 'mżawka';
  if ([61, 63, 65, 66, 67].includes(code)) return 'deszcz';
  if ([71, 73, 75, 77].includes(code)) return 'śnieg';
  if ([80, 81, 82].includes(code)) return 'przelotne opady deszczu';
  if ([85, 86].includes(code)) return 'przelotne opady śniegu';
  if ([95, 96, 99].includes(code)) return 'burza';
  return 'zmienne warunki';
}

function extractWeatherPlace(text: string): string {
  const afterPreposition = text.match(/\b(?:w|we|dla)\s+([\p{L}][\p{L}\p{M} .'-]{1,80})/iu)?.[1]
    ?.replace(/\b(?:dzisiaj|dziś|jutro|teraz|rano|wieczorem|na\s+dziś|na\s+jutro)\b.*$/iu, '')
    .trim();
  if (afterPreposition) return afterPreposition;

  return text
    .replace(/\b(?:sprawdź|sprawdz|pokaż|pokaz|jaka|jaki|jakie|jest|będzie|bedzie|proszę|prosze|mi|dla|pogoda|pogodę|pogode|temperatura|temperaturę|temperature|prognoza|prognozę|prognoze|weather|forecast|today|tomorrow|dzisiaj|dziś|jutro|teraz)\b/giu, ' ')
    .replace(/[?!.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  private readonly tools = new ToolRegistry();
  private readonly installOperations = new Map<string, InstallOperation>();

  constructor(workspaceDir: string) {
    this.workspaceDir = resolve(workspaceDir);
    registerDefaultTools(this.tools);
  }

  async listWorkspaceFiles(): Promise<string[]> {
    await mkdir(this.workspaceDir, { recursive: true });
    const root = await realpath(this.workspaceDir);
    const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    const files: string[] = [];

    while (pending.length && files.length < 200) {
      const current = pending.shift()!;
      const names = await this.tools.execute('list_files', { path: current.directory }) as string[];
      for (const name of names) {
        if (name === 'node_modules' || name === '.git' || name === '.venv' || name.startsWith('.')) continue;
        const target = resolve(current.directory, name);
        const relativePath = relative(root, target);
        if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) continue;
        const info = await lstat(target);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory() && current.depth < 3) {
          pending.push({ directory: target, depth: current.depth + 1 });
        } else if (info.isFile() && info.size <= maxReadableFileBytes && readableExtensions.has(extname(name).toLowerCase())) {
          files.push(relativePath.split(sep).join('/'));
          if (files.length >= 200) break;
        }
      }
    }

    return files.sort((left, right) => left.localeCompare(right));
  }

  async readWorkspaceFile(relativePath: unknown): Promise<{ path: string; content: string }> {
    if (typeof relativePath !== 'string' || !relativePath.trim() || isAbsolute(relativePath)) {
      throw new LocalCapabilityError(400, 'Workspace-relative path is required');
    }
    const root = await realpath(this.workspaceDir);
    const target = resolve(root, relativePath);
    const safeRelativePath = relative(root, target);
    if (!safeRelativePath || safeRelativePath.startsWith('..') || isAbsolute(safeRelativePath)) {
      throw new LocalCapabilityError(400, 'Path is outside the Nexus workspace');
    }
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new LocalCapabilityError(400, 'Only regular workspace files can be read');
    if (!readableExtensions.has(extname(target).toLowerCase())) throw new LocalCapabilityError(415, 'This file type is not readable by the project inspector');
    if (info.size > maxReadableFileBytes) throw new LocalCapabilityError(413, 'Project inspection limit is 128 KB per file');

    const content = await this.tools.execute('read_file', { path: target }) as string;
    return { path: safeRelativePath.split(sep).join('/'), content };
  }

  async writeWorkspaceFile(relativePath: unknown, contentValue: unknown, confirmed: unknown): Promise<{ path: string; bytes: number }> {
    if (confirmed !== true) throw new LocalCapabilityError(403, 'Explicit approval is required to modify a workspace file');
    if (typeof relativePath !== 'string' || !relativePath.trim() || isAbsolute(relativePath)) {
      throw new LocalCapabilityError(400, 'Workspace-relative path is required');
    }
    if (typeof contentValue !== 'string' || Buffer.byteLength(contentValue, 'utf8') > maxReadableFileBytes) {
      throw new LocalCapabilityError(413, 'Generated source changes are limited to 128 KB per file');
    }

    const root = await realpath(this.workspaceDir);
    const target = resolve(root, relativePath);
    const safeRelativePath = relative(root, target);
    if (!safeRelativePath || safeRelativePath.startsWith('..') || isAbsolute(safeRelativePath)) {
      throw new LocalCapabilityError(400, 'Path is outside the Nexus workspace');
    }
    if (!readableExtensions.has(extname(target).toLowerCase())) {
      throw new LocalCapabilityError(415, 'Only approved text/source files can be modified');
    }

    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new LocalCapabilityError(404, 'Only existing workspace files can be modified');
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new LocalCapabilityError(400, 'Only regular workspace files can be modified');
    const canonicalTarget = await realpath(target);
    const canonicalRelativePath = relative(root, canonicalTarget);
    if (!canonicalRelativePath || canonicalRelativePath.startsWith('..') || isAbsolute(canonicalRelativePath)) {
      throw new LocalCapabilityError(400, 'Path is outside the Nexus workspace');
    }

    await this.tools.execute('write_file', { path: canonicalTarget, content: contentValue }, { permissions: ['write'] });
    return { path: canonicalRelativePath.split(sep).join('/'), bytes: Buffer.byteLength(contentValue, 'utf8') };
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

  async getWeather(query: string): Promise<WeatherResult> {
    const normalized = query.trim();
    if (normalized.length < 2 || normalized.length > 300) {
      throw new LocalCapabilityError(400, 'Weather query must contain 2 to 300 characters');
    }

    const place = extractWeatherPlace(normalized);
    if (!place) {
      throw new LocalCapabilityError(400, 'Podaj miejscowość, np. „pogoda w Kolonii”.');
    }

    let geocodeResponse: Response;
    try {
      const geocodeUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
      geocodeUrl.searchParams.set('name', place);
      geocodeUrl.searchParams.set('count', '1');
      geocodeUrl.searchParams.set('language', 'pl');
      geocodeUrl.searchParams.set('format', 'json');
      geocodeResponse = await fetch(geocodeUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'NexusAI/1.0 (weather)' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new LocalCapabilityError(502, error instanceof Error ? error.message : 'Weather geocoding failed');
    }
    if (!geocodeResponse.ok) throw new LocalCapabilityError(502, `Weather geocoding returned HTTP ${geocodeResponse.status}`);

    const geocode = await geocodeResponse.json() as any;
    const location = Array.isArray(geocode?.results) ? geocode.results[0] : undefined;
    if (!location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
      throw new LocalCapabilityError(404, `Nie znaleziono miejscowości: ${place}`);
    }

    let forecastResponse: Response;
    try {
      const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
      forecastUrl.searchParams.set('latitude', String(location.latitude));
      forecastUrl.searchParams.set('longitude', String(location.longitude));
      forecastUrl.searchParams.set('timezone', 'auto');
      forecastUrl.searchParams.set('forecast_days', '3');
      forecastUrl.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m');
      forecastUrl.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
      forecastResponse = await fetch(forecastUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'NexusAI/1.0 (weather)' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new LocalCapabilityError(502, error instanceof Error ? error.message : 'Weather forecast failed');
    }
    if (!forecastResponse.ok) throw new LocalCapabilityError(502, `Weather forecast returned HTTP ${forecastResponse.status}`);

    const forecast = await forecastResponse.json() as any;
    const current = forecast?.current ?? {};
    const daily = forecast?.daily ?? {};
    const times = Array.isArray(daily.time) ? daily.time : [];

    return {
      provider: 'Open-Meteo',
      location: {
        name: String(location.name ?? place),
        country: typeof location.country === 'string' ? location.country : undefined,
        latitude: location.latitude,
        longitude: location.longitude,
        timezone: typeof forecast?.timezone === 'string' ? forecast.timezone : undefined,
      },
      current: {
        temperatureC: numberOrUndefined(current.temperature_2m),
        apparentTemperatureC: numberOrUndefined(current.apparent_temperature),
        humidityPercent: numberOrUndefined(current.relative_humidity_2m),
        windKmh: numberOrUndefined(current.wind_speed_10m),
        weatherCode: numberOrUndefined(current.weather_code),
        description: weatherCodeDescription(numberOrUndefined(current.weather_code)),
        time: typeof current.time === 'string' ? current.time : undefined,
      },
      daily: times.map((date: string, index: number) => {
        const code = numberOrUndefined(daily.weather_code?.[index]);
        return {
          date,
          minC: numberOrUndefined(daily.temperature_2m_min?.[index]),
          maxC: numberOrUndefined(daily.temperature_2m_max?.[index]),
          precipitationProbabilityPercent: numberOrUndefined(daily.precipitation_probability_max?.[index]),
          weatherCode: code,
          description: weatherCodeDescription(code),
        };
      }),
    };
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
      setupFallback: process.platform === 'win32' && !version ? 'MICROSOFT_STORE_APP_INSTALLER' as const : undefined,
      requiresConfirmation: true,
      apps: installableApps,
    };
  }

  async openInstallerSetup(confirmed: unknown): Promise<{ opened: boolean; available: boolean; packageManager: string }> {
    if (confirmed !== true) throw new LocalCapabilityError(403, 'Explicit confirmation is required to open the installer setup');
    if (process.platform !== 'win32') throw new LocalCapabilityError(501, 'Installer setup is only supported on Windows');
    if (await wingetVersion()) return { opened: false, available: true, packageManager: 'winget' };

    await new Promise<void>((resolveOpen, rejectOpen) => {
      execFile('explorer.exe', ['ms-windows-store://pdp/?ProductId=9NBLGGH4NNS1'], { timeout: 10000, windowsHide: true }, (error) => {
        if (error) rejectOpen(new LocalCapabilityError(502, `Could not open Microsoft Store: ${error.message}`));
        else resolveOpen();
      });
    });
    return { opened: true, available: false, packageManager: 'winget' };
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
