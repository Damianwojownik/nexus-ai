export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WeatherResult {
  provider: 'Open-Meteo';
  location: { name: string; country?: string; latitude: number; longitude: number; timezone?: string };
  current: { temperatureC?: number; apparentTemperatureC?: number; humidityPercent?: number; windKmh?: number; weatherCode?: number; description: string; time?: string };
  daily: Array<{ date: string; minC?: number; maxC?: number; precipitationProbabilityPercent?: number; weatherCode?: number; description: string }>;
}

export interface ImportedWorkspaceFile {
  filename: string;
  bytes: number;
  location: 'workspace';
}

export interface InstallableApp {
  id: string;
  name: string;
  publisher: string;
  description: string;
}

export interface InstallCatalog {
  supported: boolean;
  packageManager: string;
  available: boolean;
  packageManagerVersion?: string;
  setupFallback?: 'MICROSOFT_STORE_APP_INSTALLER';
  requiresConfirmation: boolean;
  apps: InstallableApp[];
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

export class LocalCapabilitiesError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

const buildEnv = import.meta.env;
const processEnv = typeof process !== 'undefined' ? process.env : undefined;
const defaultBaseUrl = buildEnv?.VITE_NEXUS_AGENT_HUB_URL || processEnv?.NEXUS_AGENT_HUB_URL || 'http://127.0.0.1:8788';

export class LocalCapabilitiesClient {
  readonly baseUrl: string;

  constructor(baseUrl = defaultBaseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        signal: init.signal ?? AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw new LocalCapabilitiesError(error instanceof Error ? error.message : 'Local capability request failed');
    }

    if (!response.ok) {
      let message = `Request failed with HTTP ${response.status}`;
      try {
        const body = await response.json() as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // Keep the HTTP status as the actionable error.
      }
      throw new LocalCapabilitiesError(message, response.status);
    }
    return response.json() as Promise<T>;
  }

  async searchWeb(query: string): Promise<{ query: string; provider: string; results: WebSearchResult[] }> {
    return this.request(`/api/search?q=${encodeURIComponent(query)}`);
  }

  async getWeather(query: string): Promise<WeatherResult> {
    return this.request(`/api/weather?q=${encodeURIComponent(query)}`);
  }

  async importFile(file: File): Promise<ImportedWorkspaceFile> {
    if (file.size > 10 * 1024 * 1024) throw new LocalCapabilitiesError('Import limit is 10 MB');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    const contentBase64 = btoa(binary);
    const result = await this.request<{ file: ImportedWorkspaceFile }>('/api/workspace/import', {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, contentBase64 }),
    });
    return result.file;
  }

  async listWorkspaceFiles(): Promise<string[]> {
    const result = await this.request<{ files: string[] }>('/api/workspace/files');
    return result.files;
  }

  async readWorkspaceFile(path: string): Promise<{ path: string; content: string }> {
    const result = await this.request<{ file: { path: string; content: string } }>(`/api/workspace/file?path=${encodeURIComponent(path)}`);
    return result.file;
  }

  async writeWorkspaceFile(path: string, content: string, confirmed: boolean): Promise<{ path: string; bytes: number }> {
    const result = await this.request<{ file: { path: string; bytes: number } }>('/api/workspace/file', {
      method: 'POST',
      body: JSON.stringify({ path, content, confirmed }),
    });
    return result.file;
  }

  async getInstallCatalog(): Promise<InstallCatalog> {
    return this.request('/api/install/catalog');
  }

  async startInstall(packageId: string, confirmed: boolean): Promise<InstallOperation> {
    const result = await this.request<{ operation: InstallOperation }>('/api/install', {
      method: 'POST',
      body: JSON.stringify({ packageId, confirmed }),
    });
    return result.operation;
  }

  async openInstallerSetup(confirmed: boolean): Promise<{ opened: boolean; available: boolean; packageManager: string }> {
    return this.request('/api/install/setup', {
      method: 'POST',
      body: JSON.stringify({ confirmed }),
    });
  }

  async getInstallOperation(operationId: string): Promise<InstallOperation> {
    const result = await this.request<{ operation: InstallOperation }>(`/api/install/${encodeURIComponent(operationId)}`);
    return result.operation;
  }

}
