export type AIModelMode = 'LOCAL' | 'AUTO' | 'CLOUD';
export type ProviderRole = 'PRIMARY_ORCHESTRATOR' | 'SUBAGENT';

export interface ModelProvider {
  readonly name: string;
  readonly mode: AIModelMode;
  readonly role: ProviderRole;
  generate(prompt: string, options?: Record<string, any>): Promise<string>;
  checkHealth(): Promise<{ status: 'CONNECTED' | 'OFFLINE' | 'NO_MODEL' | 'ERROR'; model?: string; error?: string; models?: any[] }>;
  listModels(): Promise<any[]>;
}

export class OllamaProvider implements ModelProvider {
  readonly name = 'Ollama';
  readonly mode: AIModelMode = 'LOCAL';
  readonly role: ProviderRole = 'SUBAGENT';

  private client: any;

  constructor(client: any) {
    this.client = client;
  }

  async checkHealth() {
    return this.client.checkHealth();
  }

  async listModels() {
    return this.client.listModels();
  }

  async generate(prompt: string, options: Record<string, any> = {}) {
    return this.client.generate({ ...options, prompt });
  }
}

export class ModelRouter {
  private providers: ModelProvider[];
  private preferredMode: AIModelMode;
  private primaryProvider?: ModelProvider;

  constructor(preferredMode: AIModelMode = 'AUTO', providers: ModelProvider[] = [], primaryProvider?: ModelProvider) {
    this.preferredMode = preferredMode;
    this.providers = providers;
    this.primaryProvider = primaryProvider;
  }

  setPreferredMode(mode: AIModelMode) {
    this.preferredMode = mode;
  }

  setPrimaryProvider(provider?: ModelProvider) {
    this.primaryProvider = provider;
  }

  register(provider: ModelProvider) {
    if (!this.providers.some((item) => item.name === provider.name)) this.providers.push(provider);
  }

  private localCandidates(): ModelProvider[] {
    return this.providers.filter((p) => p.mode === 'LOCAL' || p.name === 'Ollama' || p.role === 'SUBAGENT');
  }

  private async tryProvider(provider: ModelProvider | undefined, prompt: string, options: Record<string, any>) {
    if (!provider) return undefined;
    const health = await provider.checkHealth();
    if (health.status !== 'CONNECTED') return undefined;
    try {
      const text = await provider.generate(prompt, options);
      if (typeof text === 'string' && text.trim()) return text;
    } catch {
      // Quota, transient network failures and provider-specific errors may fall through
      // to the next configured provider in AUTO mode.
    }
    return undefined;
  }

  async route(prompt: string, options: Record<string, any> = {}) {
    if (this.preferredMode === 'LOCAL') {
      for (const provider of this.localCandidates()) {
        const result = await this.tryProvider(provider, prompt, options);
        if (result !== undefined) return result;
      }
      throw new Error('Local provider unavailable.');
    }

    if (this.preferredMode === 'CLOUD') {
      const result = await this.tryProvider(this.primaryProvider, prompt, options);
      if (result !== undefined) return result;
      throw new Error('Cloud provider is not configured or unavailable.');
    }

    const primaryResult = await this.tryProvider(this.primaryProvider, prompt, options);
    if (primaryResult !== undefined) return primaryResult;

    for (const provider of this.localCandidates()) {
      const result = await this.tryProvider(provider, prompt, options);
      if (result !== undefined) return result;
    }

    throw new Error('No AI provider is currently available.');
  }
}
