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

  setPrimaryProvider(provider: ModelProvider) {
    this.primaryProvider = provider;
  }

  register(provider: ModelProvider) {
    this.providers.push(provider);
  }

  async route(prompt: string, options: Record<string, any> = {}) {
    const localProvider = this.providers.find((p) => p.mode === 'LOCAL' || p.name === 'Ollama' || p.role === 'SUBAGENT');

    if (this.preferredMode === 'LOCAL') {
      if (!localProvider) throw new Error('Local provider is not registered.');
      const health = await localProvider.checkHealth();
      if (health.status !== 'CONNECTED') throw new Error(`Local provider unavailable: ${health.status}`);
      return localProvider.generate(prompt, options);
    }

    if (this.primaryProvider) {
      const primaryHealth = await this.primaryProvider.checkHealth();
      if (primaryHealth.status === 'CONNECTED') {
        try {
          return await this.primaryProvider.generate(prompt, options);
        } catch (error) {
          if (this.preferredMode === 'CLOUD') throw error;
          // Quota exhaustion and temporary remote failures fall through to the free local model in AUTO.
        }
      } else if (this.preferredMode === 'CLOUD') {
        throw new Error(`Cloud provider unavailable: ${primaryHealth.error || primaryHealth.status}`);
      }
    } else if (this.preferredMode === 'CLOUD') {
      throw new Error('Cloud provider is not configured yet.');
    }

    if (!localProvider) throw new Error('No local fallback provider available.');
    const health = await localProvider.checkHealth();
    if (health.status === 'CONNECTED') return localProvider.generate(prompt, options);

    throw new Error(`Local provider unavailable: ${health.status}`);
  }
}
