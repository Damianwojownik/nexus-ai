// On a phone the browser's 127.0.0.1 points to the phone, not the Windows PC.
// The paired mobile gateway exposes the SAME origin over private HTTPS.
function isRemoteBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  const hostname = window.location.hostname.toLowerCase();
  return !['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

export function hubEndpoint(): string {
  if (isRemoteBrowser()) return window.location.origin;
  const env = import.meta.env;
  const local = typeof process !== 'undefined' ? process.env?.NEXUS_AGENT_HUB_URL : undefined;
  return env?.VITE_NEXUS_AGENT_HUB_URL || local || 'http://127.0.0.1:8788';
}

export function ollamaEndpoint(): string {
  if (isRemoteBrowser()) return window.location.origin + '/ollama';
  const env = import.meta.env;
  const local = typeof process !== 'undefined' ? process.env?.OLLAMA_BASE_URL : undefined;
  return env?.VITE_OLLAMA_BASE_URL || local || 'http://127.0.0.1:11434';
}
