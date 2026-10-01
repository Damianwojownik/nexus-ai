export function getPublicBaseUrl(request: Request): { baseUrl: string; isSandbox: boolean } {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const isSandbox = url.hostname.includes(".sandbox.floot.app") || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return { baseUrl, isSandbox };
}
