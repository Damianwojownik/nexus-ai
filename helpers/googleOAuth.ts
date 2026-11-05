import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/business.manage',
];

interface PendingAuthorization {
  verifier: string;
  createdAt: number;
  returnOrigin?: string;
}

interface StoredGoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope: string[];
  token_type?: string;
}

function configured(name: string): string {
  return (process.env[name] ?? '').trim();
}

function tokenFilePath(): string {
  if (configured('NEXUS_GOOGLE_TOKEN_FILE')) return configured('NEXUS_GOOGLE_TOKEN_FILE');
  const dataDirectory = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'NexusAI')
    : join(homedir(), '.nexus-ai');
  return join(dataDirectory, 'google-oauth-tokens.json');
}

function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((scope): scope is string => typeof scope === 'string');
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return [];
}

export class GoogleOAuthManager {
  private readonly pending = new Map<string, PendingAuthorization>();
  private tokenCache?: StoredGoogleTokens;

  private clientId(): string {
    const value = configured('GOOGLE_OAUTH_CLIENT_ID');
    if (!value) throw new Error('Brakuje GOOGLE_OAUTH_CLIENT_ID w środowisku serwera Nexusa.');
    return value;
  }

  private clientSecret(): string {
    const value = configured('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!value) throw new Error('Brakuje GOOGLE_OAUTH_CLIENT_SECRET w środowisku serwera Nexusa.');
    return value;
  }

  private redirectUri(): string {
    const value = configured('GOOGLE_OAUTH_REDIRECT_URI');
    if (!value) throw new Error('Brakuje GOOGLE_OAUTH_REDIRECT_URI. Dodaj dokładny adres callback w Google Cloud Console.');
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error('Produkcyjny Google OAuth redirect URI musi używać HTTPS.');
    }
    return url.toString();
  }

  async status(): Promise<{
    clientConfigured: boolean;
    redirectUriConfigured: boolean;
    connected: boolean;
    scopes: string[];
    expiresAt?: string;
    tokenStorage: 'local-protected-file';
  }> {
    let tokens: StoredGoogleTokens | undefined;
    try {
      tokens = await this.loadTokens();
    } catch {
      tokens = undefined;
    }
    return {
      clientConfigured: Boolean(configured('GOOGLE_OAUTH_CLIENT_ID') && configured('GOOGLE_OAUTH_CLIENT_SECRET')),
      redirectUriConfigured: Boolean(configured('GOOGLE_OAUTH_REDIRECT_URI')),
      connected: Boolean(tokens?.refresh_token || (tokens?.access_token && tokens.expires_at > Date.now())),
      scopes: tokens?.scope ?? [],
      expiresAt: tokens?.expires_at ? new Date(tokens.expires_at).toISOString() : undefined,
      tokenStorage: 'local-protected-file',
    };
  }

  async startAuthorization(returnOrigin?: string): Promise<{ authorizationUrl: string }> {
    const clientId = this.clientId();
    const redirectUri = this.redirectUri();
    this.clientSecret();

    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.pending.set(state, { verifier, createdAt: Date.now(), returnOrigin });
    for (const [oldState, pending] of this.pending) {
      if (Date.now() - pending.createdAt > 10 * 60 * 1000) this.pending.delete(oldState);
    }

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: url.toString() };
  }

  async completeAuthorization(callbackUrl: URL): Promise<{ connected: true; scopes: string[]; expiresAt: string; returnOrigin?: string }> {
    const oauthError = callbackUrl.searchParams.get('error');
    if (oauthError) throw new Error('Google OAuth nie został zakończony: ' + oauthError);
    const code = callbackUrl.searchParams.get('code');
    const state = callbackUrl.searchParams.get('state');
    if (!code || !state) throw new Error('Google OAuth callback nie zawiera wymaganych parametrów.');
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) {
      throw new Error('Sesja Google OAuth wygasła lub była nieprawidłowa. Rozpocznij połączenie ponownie.');
    }

    const previous = await this.loadTokens().catch(() => undefined);
    const body = new URLSearchParams({
      code,
      client_id: this.clientId(),
      client_secret: this.clientSecret(),
      redirect_uri: this.redirectUri(),
      grant_type: 'authorization_code',
      code_verifier: pending.verifier,
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok || typeof data.access_token !== 'string') {
      throw new Error(data?.error_description || data?.error || 'Google OAuth token exchange failed.');
    }

    const tokens: StoredGoogleTokens = {
      access_token: data.access_token,
      refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : previous?.refresh_token,
      expires_at: Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000,
      scope: parseScopes(data.scope).length ? parseScopes(data.scope) : (previous?.scope ?? []),
      token_type: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
    };
    if (!tokens.refresh_token) throw new Error('Google nie zwrócił refresh tokenu. Usuń wcześniejszą zgodę aplikacji w Google Account i połącz konto ponownie.');
    await this.saveTokens(tokens);
    return { connected: true, scopes: tokens.scope, expiresAt: new Date(tokens.expires_at).toISOString(), returnOrigin: pending.returnOrigin };
  }

  async accessToken(requiredScope: string): Promise<string> {
    let tokens = await this.loadTokens();
    if (!tokens) throw new Error('Konto Google nie jest połączone z Nexusem. Uruchom Google OAuth.');
    if (!tokens.scope.includes(requiredScope)) {
      throw new Error('Połączone konto Google nie ma wymaganej zgody OAuth: ' + requiredScope);
    }
    if (tokens.expires_at <= Date.now() + 60_000) {
      if (!tokens.refresh_token) throw new Error('Token Google wygasł i nie ma refresh tokenu. Połącz konto ponownie.');
      const body = new URLSearchParams({
        client_id: this.clientId(),
        client_secret: this.clientSecret(),
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      });
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(20000),
      });
      const data = await response.json().catch(() => ({})) as any;
      if (!response.ok || typeof data.access_token !== 'string') {
        throw new Error(data?.error_description || data?.error || 'Google access token refresh failed.');
      }
      tokens = {
        ...tokens,
        access_token: data.access_token,
        expires_at: Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000,
      };
      await this.saveTokens(tokens);
    }
    return tokens.access_token;
  }

  async disconnect(): Promise<void> {
    this.tokenCache = undefined;
    try {
      await rm(tokenFilePath(), { force: true });
    } catch {
      // A missing token file is already disconnected.
    }
  }

  private async loadTokens(): Promise<StoredGoogleTokens | undefined> {
    if (this.tokenCache) return this.tokenCache;
    try {
      const raw = await readFile(tokenFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as StoredGoogleTokens;
      if (typeof parsed.access_token !== 'string' || typeof parsed.expires_at !== 'number' || !Array.isArray(parsed.scope)) {
        return undefined;
      }
      this.tokenCache = parsed;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async saveTokens(tokens: StoredGoogleTokens): Promise<void> {
    const filePath = tokenFilePath();
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
    this.tokenCache = tokens;
  }
}

export const googleOAuthManager = new GoogleOAuthManager();
