export type AIModelMode = 'LOCAL' | 'AUTO' | 'CLOUD';

export interface ModelProvider {
  readonly name: string;
  readonly mode: AIModelMode;
  generate(prompt: string, options?: Record<string, any>): Promise<string>;
  checkHealth(): Promise<{ status: 'CONNECTED' | 'OFFLINE' | 'NO_MODEL' | 'ERROR'; model?: string; error?: string; models?: any[] }>;
  listModels(): Promise<any[]>;
}

export class OllamaProvider implements ModelProvider {
  readonly name = 'Ollama';
  readonly mode: AIModelMode = 'LOCAL';

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

  constructor(preferredMode: AIModelMode = 'AUTO', providers: ModelProvider[] = []) {
    this.preferredMode = preferredMode;
    this.providers = providers;
  }

  setPreferredMode(mode: AIModelMode) {
    this.preferredMode = mode;
  }

  register(provider: ModelProvider) {
    this.providers.push(provider);
  }

  async route(prompt: string, options: Record<string, any> = {}) {
    if (this.preferredMode === 'LOCAL') {
      const provider = this.providers.find((p) => p.name === 'Ollama');
      if (!provider) throw new Error('Ollama provider is not registered.');
      return provider.generate(prompt, options);
    }

    const localProvider = this.providers.find((p) => p.name === 'Ollama');
    if (!localProvider) {
      throw new Error('No provider available.');
    }

    const health = await localProvider.checkHealth();
    if (health.status === 'CONNECTED') {
      return localProvider.generate(prompt, options);
    }

    if (this.preferredMode === 'CLOUD') {
      throw new Error('Cloud provider is not configured yet.');
    }

    throw new Error(`Local provider unavailable: ${health.status}`);
  }
}
