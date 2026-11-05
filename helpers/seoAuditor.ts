import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { load } from 'cheerio';
import { googleOAuthManager } from './googleOAuth.ts';

export interface SeoIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  code: string;
  page: string;
  title: string;
  detail: string;
  recommendation: string;
}

export interface SeoPageResult {
  url: string;
  status: number;
  title: string;
  titleLength: number;
  description: string;
  descriptionLength: number;
  canonical?: string;
  robots?: string;
  h1Count: number;
  headingOutline: string[];
  wordCount: number;
  contentExcerpt: string;
  imageCount: number;
  imagesMissingAlt: number;
  internalLinks: number;
  externalLinks: number;
  jsonLdTypes: string[];
  hasFaqSchema: boolean;
  hasLocalBusinessSchema: boolean;
  questionHeadings: number;
}

export interface SeoAuditResult {
  site: string;
  crawledAt: string;
  pagesScanned: number;
  maxPages: number;
  robotsTxt: { found: boolean; disallowsAll: boolean; sitemaps: string[] };
  sitemapUrls: number;
  pages: SeoPageResult[];
  issues: SeoIssue[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    pagesWithNoTitle: number;
    pagesWithNoDescription: number;
    pagesWithMultipleH1: number;
    pagesWithNoCanonical: number;
    pagesWithNoStructuredData: number;
  };
  aeo: {
    pagesWithQuestionHeadings: number;
    pagesWithFaqSchema: number;
    pagesWithStructuredData: number;
    averageWordsPerPage: number;
    directAnswerReadiness: 'low' | 'medium' | 'high';
    notes: string[];
  };
  limitations: string[];
}

export interface PageSpeedResult {
  url: string;
  strategy: 'mobile' | 'desktop';
  fetchedAt: string;
  scores: {
    performance?: number;
    accessibility?: number;
    bestPractices?: number;
    seo?: number;
  };
  lab: {
    lcpMs?: number;
    fcpMs?: number;
    cls?: number;
    tbtMs?: number;
    speedIndexMs?: number;
  };
  field?: {
    source: string;
    overallCategory?: string;
    metrics: Record<string, { percentile?: number; category?: string }>;
  };
  opportunities: Array<{ id: string; title: string; savingsMs?: number; description: string }>;
  limitations: string[];
}

const USER_AGENT = 'NexusAI-SEO-Audit/1.0 (+https://github.com/Damianwojownik/nexus-ai)';
const MAX_HTML_BYTES = 1_500_000;
const MAX_PAGES_DEFAULT = 30;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 12_000;

function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0);
}

function isPrivateIpv6(ip: string): boolean {
  const value = ip.toLowerCase().split('%')[0];
  if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
    || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea')
    || value.startsWith('feb') || value.startsWith('ff')) return true;

  if (value.startsWith('::ffff:')) {
    const tail = value.slice(7);
    if (isIP(tail) === 4) return isPrivateIpv4(tail);
    const words = tail.split(':');
    if (words.length >= 2) {
      const high = Number.parseInt(words[words.length - 2], 16);
      const low = Number.parseInt(words[words.length - 1], 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        return isPrivateIpv4([high >> 8, high & 255, low >> 8, low & 255].join('.'));
      }
    }
    return true;
  }
  return false;
}

function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !isPrivateIpv4(ip);
  if (family === 6) return !isPrivateIpv6(ip);
  return false;
}

function normalizeTarget(value: unknown): URL {
  if (typeof value !== 'string' || value.trim().length < 4 || value.length > 2048) {
    throw new Error('Podaj poprawny publiczny adres strony (http:// lub https://).');
  }
  let url: URL;
  try {
    url = new URL(value.trim().includes('://') ? value.trim() : 'https://' + value.trim());
  } catch {
    throw new Error('Nie udało się odczytać adresu strony.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Dozwolone są wyłącznie adresy HTTP i HTTPS.');
  if (url.username || url.password) throw new Error('Adres strony nie może zawierać danych logowania.');
  if (url.port && url.port !== '80' && url.port !== '443') throw new Error('Dostępne są tylko standardowe porty HTTP i HTTPS.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|test|invalid|example)$/.test(host)) {
    throw new Error('Adres lokalny lub zarezerwowany nie może być skanowany.');
  }
  url.hash = '';
  return url;
}

async function publicAddresses(hostname: string): Promise<Array<{ address: string; family: number }>> {
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dnsLookup(hostname, { all: true, verbatim: true });

  if (!addresses.length || addresses.some((item) => !isPublicIp(item.address))) {
    throw new Error('Adres wskazuje na sieć prywatną, lokalną lub zarezerwowaną. Żądanie zablokowano.');
  }
  return addresses;
}

type HttpPayload = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; url: string };

async function requestPublic(
  input: URL,
  allowedHost: string,
  redirectCount = 0,
): Promise<HttpPayload> {
  if (input.hostname.toLowerCase() !== allowedHost.toLowerCase()) {
    throw new Error('Przekierowanie poza pierwotną domenę zostało zablokowane.');
  }
  const addresses = await publicAddresses(input.hostname);
  const selected = addresses[0];
  const transport = input.protocol === 'https:' ? httpsRequest : httpRequest;

  const result = await new Promise<HttpPayload>((resolve, reject) => {
    const request = transport(input, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.8,*/*;q=0.1',
        'Accept-Encoding': 'identity',
        Connection: 'close',
      },
      timeout: REQUEST_TIMEOUT_MS,
      lookup: ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
        callback(null, selected.address, selected.family);
      }) as any,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_HTML_BYTES) {
          request.destroy(new Error('Strona przekracza limit 1,5 MB.'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        const headers: Record<string, string | string[] | undefined> = {};
        for (const [key, value] of Object.entries(response.headers)) headers[key] = value;
        resolve({
          status: response.statusCode ?? 0,
          headers,
          body: Buffer.concat(chunks),
          url: input.toString(),
        });
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Przekroczono limit czasu połączenia.')));
    request.on('error', reject);
    request.end();
  });

  const location = result.headers.location;
  if ([301, 302, 303, 307, 308].includes(result.status) && typeof location === 'string') {
    if (redirectCount >= MAX_REDIRECTS) throw new Error('Przekroczono limit przekierowań.');
    const next = new URL(location, input);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('Nieobsługiwany protokół przekierowania.');
    if (next.hostname.toLowerCase() !== allowedHost.toLowerCase()) throw new Error('Przekierowanie poza pierwotną domenę zostało zablokowane.');
    return requestPublic(next, allowedHost, redirectCount + 1);
  }

  return result;
}

export function parseRobots(text: string): { disallow: string[]; sitemaps: string[]; disallowsAll: boolean } {
  const disallow: string[] = [];
  const sitemaps: string[] = [];
  let groupAgents: string[] = [];
  let groupRules: string[] = [];

  const flushGroup = () => {
    if (groupAgents.includes('*')) disallow.push(...groupRules);
    groupAgents = [];
    groupRules = [];
  };

  for (const rawLine of text.split(/\\r?\\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      // A new user-agent after rules starts a new group; adjacent user-agent
      // directives before any rule belong to the same group.
      if (groupRules.length) flushGroup();
      groupAgents.push(value.toLowerCase());
    } else if (key === 'disallow' && value) {
      groupRules.push(value);
    } else if (key === 'sitemap' && /^https?:\\/\\//i.test(value)) {
      sitemaps.push(value);
    }
  }
  flushGroup();

  const uniqueDisallow = [...new Set(disallow)];
  return {
    disallow: uniqueDisallow,
    sitemaps: [...new Set(sitemaps)].slice(0, 5),
    disallowsAll: uniqueDisallow.includes('/'),
  };
}

function isDisallowed(pathname: string, disallow: string[]): boolean {
  return disallow.some((rule) => rule !== '/' && pathname.startsWith(rule)) || disallow.includes('/');
}

function addIssue(issues: SeoIssue[], issue: SeoIssue): void {
  issues.push(issue);
}

function collectJsonLdTypes($: ReturnType<typeof load>): string[] {
  const types = new Set<string>();
  $('script[type="application/ld+json"]').each((_index, node) => {
    const raw = $(node).contents().text().trim();
    if (!raw || raw.length > 200_000) return;
    try {
      const parsed: any = JSON.parse(raw);
      const visit = (value: any): void => {
        if (!value || typeof value !== 'object') return;
        const type = value['@type'];
        if (typeof type === 'string') types.add(type);
        else if (Array.isArray(type)) type.filter((x) => typeof x === 'string').forEach((x) => types.add(x));
        if (Array.isArray(value)) value.forEach(visit);
        if (value['@graph']) visit(value['@graph']);
      };
      visit(parsed);
    } catch {
      // A malformed JSON-LD block is reported separately at the page level.
      types.add('__INVALID_JSON_LD__');
    }
  });
  return [...types];
}

function inspectPage(url: string, status: number, html: string, origin: string, issues: SeoIssue[]): SeoPageResult {
  const $ = load(html);
  $('script,style,noscript,svg').remove();
  const title = $('title').first().text().trim();
  const description = ($('meta[name="description"]').attr('content') ?? '').trim();
  const canonicalRaw = $('link[rel~="canonical"]').first().attr('href');
  const canonical = canonicalRaw ? new URL(canonicalRaw, url).toString() : undefined;
  const robots = ($('meta[name="robots"]').attr('content') ?? $('meta[name="googlebot"]').attr('content') ?? '').trim();
  const headingOutline: string[] = [];
  $('h1,h2,h3,h4,h5,h6').each((_index, item) => {
    const tag = item.tagName.toLowerCase();
    headingOutline.push(tag + ': ' + $(item).text().replace(/\s+/g, ' ').trim().slice(0, 120));
  });
  const h1Count = $('h1').length;
  const images = $('img');
  let imagesMissingAlt = 0;
  images.each((_index, image) => {
    if ($(image).attr('alt') === undefined) imagesMissingAlt += 1;
  });
  let internalLinks = 0;
  let externalLinks = 0;
  $('a[href]').each((_index, link) => {
    try {
      const href = new URL($(link).attr('href')!, url);
      if ((href.protocol === 'http:' || href.protocol === 'https:') && href.origin === origin) internalLinks += 1;
      else if (href.protocol === 'http:' || href.protocol === 'https:') externalLinks += 1;
    } catch {
      // Ignore non-URL anchors such as mailto:, tel: and fragment links.
    }
  });
  const bodyText = $('main').length ? $('main').text().replace(/\s+/g, ' ').trim() : $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;
  const contentExcerpt = bodyText.slice(0, 1800);
  const jsonLdTypes = collectJsonLdTypes($);
  const questionHeadings = headingOutline.filter((heading) => /:\s*.*\?/.test(heading) || /^(h[1-6]):\s*(jak|dlaczego|kiedy|gdzie|co|czy|how|why|when|where|what|can|does)\b/i.test(heading)).length;
  const hasFaqSchema = jsonLdTypes.includes('FAQPage');
  const hasLocalBusinessSchema = jsonLdTypes.some((type) => /LocalBusiness|Organization|Store|ProfessionalService/i.test(type));

  if (status >= 400) addIssue(issues, { severity: status >= 500 ? 'high' : 'medium', code: 'HTTP_STATUS', page: url, title: 'Strona zwraca błąd HTTP', detail: 'Kod odpowiedzi: ' + status, recommendation: 'Napraw stronę lub przekieruj ją do właściwego, działającego adresu.' });
  if (!title) addIssue(issues, { severity: 'high', code: 'TITLE_MISSING', page: url, title: 'Brak tagu title', detail: 'W dokumencie nie znaleziono tytułu strony.', recommendation: 'Dodaj unikalny, opisowy tytuł odpowiadający intencji użytkownika.' });
  else if (title.length < 30 || title.length > 60) addIssue(issues, { severity: 'low', code: 'TITLE_LENGTH', page: url, title: 'Tytuł poza zalecanym zakresem', detail: 'Długość: ' + title.length + ' znaków. Zakres kontrolny: 30–60.', recommendation: 'Dopasuj tytuł do tematu strony; zakres jest wskazówką, a nie sztywną regułą Google.' });
  if (!description) addIssue(issues, { severity: 'medium', code: 'META_DESCRIPTION_MISSING', page: url, title: 'Brak meta description', detail: 'W dokumencie nie znaleziono opisu.', recommendation: 'Dodaj unikalny opis strony, który jasno komunikuje jej zawartość.' });
  else if (description.length < 70 || description.length > 160) addIssue(issues, { severity: 'low', code: 'META_DESCRIPTION_LENGTH', page: url, title: 'Opis meta poza zakresem kontrolnym', detail: 'Długość: ' + description.length + ' znaków. Zakres kontrolny: 70–160.', recommendation: 'Rozważ zwięzłe dopasowanie opisu; wyszukiwarki mogą generować własny fragment wyników.' });
  if (h1Count === 0) addIssue(issues, { severity: 'medium', code: 'H1_MISSING', page: url, title: 'Brak nagłówka H1', detail: 'Strona nie zawiera nagłówka H1.', recommendation: 'Dodaj jeden główny nagłówek opisujący temat strony.' });
  if (h1Count > 1) addIssue(issues, { severity: 'low', code: 'H1_MULTIPLE', page: url, title: 'Wiele nagłówków H1', detail: 'Liczba nagłówków H1: ' + h1Count, recommendation: 'Sprawdź, czy struktura dokumentu jasno wskazuje główny temat; wiele H1 nie jest automatyczną karą.' });
  if (!canonical) addIssue(issues, { severity: 'low', code: 'CANONICAL_MISSING', page: url, title: 'Brak wskazanego canonical', detail: 'Nie znaleziono linku rel=canonical.', recommendation: 'Dodaj canonical, jeżeli strona ma odpowiedniki lub może być dostępna pod wieloma URL-ami.' });
  if (canonical && new URL(canonical).origin !== origin) addIssue(issues, { severity: 'high', code: 'CANONICAL_EXTERNAL', page: url, title: 'Canonical wskazuje inną domenę', detail: 'Adres canonical: ' + canonical, recommendation: 'Sprawdź, czy cross-domain canonical jest zamierzony.' });
  if (/\bnoindex\b/i.test(robots)) addIssue(issues, { severity: 'high', code: 'NOINDEX', page: url, title: 'Meta robots blokuje indeksację', detail: robots, recommendation: 'Usuń noindex, jeśli strona ma być dostępna w wynikach wyszukiwania.' });
  if (imagesMissingAlt > 0) addIssue(issues, { severity: 'medium', code: 'IMAGE_ALT_MISSING', page: url, title: 'Obrazy bez atrybutu alt', detail: imagesMissingAlt + ' z ' + images.length + ' obrazów nie ma atrybutu alt.', recommendation: 'Dodaj tekst alternatywny opisujący znaczące obrazy; dekoracyjne oznacz alt=\"\".' });
  if (jsonLdTypes.includes('__INVALID_JSON_LD__')) addIssue(issues, { severity: 'medium', code: 'JSON_LD_INVALID', page: url, title: 'Niepoprawny JSON-LD', detail: 'Co najmniej jeden blok danych strukturalnych nie jest poprawnym JSON.', recommendation: 'Popraw składnię JSON-LD i zweryfikuj go w narzędziu Rich Results Test.' });
  if (jsonLdTypes.length === 0) addIssue(issues, { severity: 'low', code: 'STRUCTURED_DATA_MISSING', page: url, title: 'Nie wykryto JSON-LD', detail: 'Na stronie nie wykryto danych strukturalnych JSON-LD.', recommendation: 'Rozważ odpowiedni typ Schema.org, jeżeli odzwierciedla rzeczywistą treść strony.' });

  return {
    url, status, title, titleLength: title.length, description, descriptionLength: description.length,
    canonical, robots, h1Count, headingOutline, wordCount, imageCount: images.length,
    imagesMissingAlt, internalLinks, externalLinks, jsonLdTypes, contentExcerpt,
    hasFaqSchema, hasLocalBusinessSchema, questionHeadings,
  };
}

async function readSmallText(url: URL, allowedHost: string): Promise<{ found: boolean; text: string }> {
  try {
    const result = await requestPublic(url, allowedHost);
    if (result.status < 200 || result.status >= 300) return { found: false, text: '' };
    return { found: true, text: result.body.toString('utf8').slice(0, 500_000) };
  } catch {
    return { found: false, text: '' };
  }
}

export async function auditPublicSite(target: unknown, requestedMaxPages = 20): Promise<SeoAuditResult> {
  const startUrl = normalizeTarget(target);
  const maxPages = Number.isInteger(requestedMaxPages) ? Math.max(1, Math.min(30, requestedMaxPages)) : MAX_PAGES_DEFAULT;
  const origin = startUrl.origin;
  const host = startUrl.hostname;
  await publicAddresses(host);

  const robotsUrl = new URL('/robots.txt', origin);
  const robotsResult = await readSmallText(robotsUrl, host);
  const robots = parseRobots(robotsResult.text);
  const issues: SeoIssue[] = [];
  const pages: SeoPageResult[] = [];

  if (robotsResult.found && robots.disallowsAll) {
    addIssue(issues, { severity: 'critical', code: 'ROBOTS_DISALLOW_ALL', page: robotsUrl.toString(), title: 'robots.txt blokuje całe indeksowanie', detail: 'Reguła Disallow: / dotyczy wszystkich crawlerów.', recommendation: 'Sprawdź intencję reguły. Nie usuwaj blokady, jeśli serwis jest celowo prywatny lub testowy.' });
  }

  let sitemapUrls: string[] = [];
  const sitemapLocations = [...robots.sitemaps, new URL('/sitemap.xml', origin).toString()].slice(0, 6);
  for (const sitemap of sitemapLocations) {
    try {
      const sitemapUrl = normalizeTarget(sitemap);
      if (sitemapUrl.hostname !== host) continue;
      const result = await requestPublic(sitemapUrl, host);
      if (result.status >= 200 && result.status < 300) {
        const $ = load(result.body.toString('utf8'));
        const locations = $('loc').map((_index, el) => $(el).text().trim()).get();
        sitemapUrls.push(...locations.filter((value) => {
          try { return new URL(value).origin === origin; } catch { return false; }
        }));
      }
    } catch {
      // A missing or invalid sitemap is reported without aborting the crawl.
    }
  }
  sitemapUrls = [...new Set(sitemapUrls)].slice(0, 100);

  const queue = [startUrl.toString(), ...sitemapUrls];
  const visited = new Set<string>();
  const knownInternalLinks = new Set<string>();

  while (queue.length && pages.length < maxPages) {
    const nextRaw = queue.shift()!;
    let next: URL;
    try { next = normalizeTarget(nextRaw); } catch { continue; }
    if (next.origin !== origin || visited.has(next.toString())) continue;
    visited.add(next.toString());
    if (isDisallowed(next.pathname, robots.disallow)) continue;

    try {
      const result = await requestPublic(next, host);
      const contentType = String(result.headers['content-type'] ?? '').toLowerCase();
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        if (result.status >= 400) addIssue(issues, { severity: 'medium', code: 'LINK_HTTP_ERROR', page: result.url, title: 'Zasób zwraca błąd HTTP', detail: 'Kod: ' + result.status, recommendation: 'Napraw lub usuń niedziałający adres wewnętrzny.' });
        continue;
      }
      const html = result.body.toString('utf8');
      const page = inspectPage(result.url, result.status, html, origin, issues);
      pages.push(page);

      const $ = load(html);
      $('a[href]').each((_index, link) => {
        try {
          const href = new URL($(link).attr('href')!, result.url);
          href.hash = '';
          if ((href.protocol === 'http:' || href.protocol === 'https:') && href.origin === origin) {
            knownInternalLinks.add(href.toString());
            if (!visited.has(href.toString()) && queue.length < 300) queue.push(href.toString());
          }
        } catch {
          // Ignore non-URL or malformed links.
        }
      });
    } catch (error) {
      addIssue(issues, { severity: 'medium', code: 'CRAWL_REQUEST_FAILED', page: next.toString(), title: 'Nie udało się pobrać strony', detail: error instanceof Error ? error.message : String(error), recommendation: 'Sprawdź dostępność serwera, TLS, robots.txt i reguły bezpieczeństwa.' });
    }
  }

  const titleGroups = new Map<string, string[]>();
  for (const page of pages) {
    const normalizedTitle = page.title.trim().toLowerCase();
    if (normalizedTitle) titleGroups.set(normalizedTitle, [...(titleGroups.get(normalizedTitle) ?? []), page.url]);
  }
  for (const [title, urls] of titleGroups) {
    if (urls.length > 1) addIssue(issues, { severity: 'medium', code: 'DUPLICATE_TITLE', page: urls.join(', '), title: 'Powtarzający się title', detail: 'Ten sam tytuł występuje na ' + urls.length + ' stronach: ' + title.slice(0, 100), recommendation: 'Nadaj ważnym stronom unikalne tytuły opisujące ich odrębny zakres.' });
  }

  const aeoPages = pages.filter((page) => page.questionHeadings > 0);
  const schemaPages = pages.filter((page) => page.jsonLdTypes.some((type) => type !== '__INVALID_JSON_LD__'));
  const faqPages = pages.filter((page) => page.hasFaqSchema);
  const averageWords = pages.length ? Math.round(pages.reduce((sum, page) => sum + page.wordCount, 0) / pages.length) : 0;
  const readinessScore = (aeoPages.length ? 1 : 0) + (schemaPages.length ? 1 : 0) + (pages.some((page) => page.wordCount >= 250) ? 1 : 0);
  const aeoNotes = [
    aeoPages.length ? 'Wykryto nagłówki w formie pytań.' : 'Nie wykryto nagłówków sformułowanych jako pytania.',
    faqPages.length ? 'Wykryto FAQPage w JSON-LD.' : 'Nie wykryto schematu FAQPage; dodawaj go wyłącznie dla widocznych, rzeczywistych pytań i odpowiedzi.',
    schemaPages.length ? 'Wykryto dane strukturalne JSON-LD.' : 'Nie wykryto danych strukturalnych JSON-LD.',
    'Wskaźnik gotowości AEO jest heurystyką treści i znaczników, a nie pomiarem widoczności w modelach AI.',
  ];

  return {
    site: origin,
    crawledAt: new Date().toISOString(),
    pagesScanned: pages.length,
    maxPages,
    robotsTxt: { found: robotsResult.found, disallowsAll: robots.disallowsAll, sitemaps: robots.sitemaps },
    sitemapUrls: sitemapUrls.length,
    pages,
    issues: issues.slice(0, 300),
    summary: {
      critical: issues.filter((issue) => issue.severity === 'critical').length,
      high: issues.filter((issue) => issue.severity === 'high').length,
      medium: issues.filter((issue) => issue.severity === 'medium').length,
      low: issues.filter((issue) => issue.severity === 'low').length,
      pagesWithNoTitle: pages.filter((page) => !page.title).length,
      pagesWithNoDescription: pages.filter((page) => !page.description).length,
      pagesWithMultipleH1: pages.filter((page) => page.h1Count > 1).length,
      pagesWithNoCanonical: pages.filter((page) => !page.canonical).length,
      pagesWithNoStructuredData: pages.filter((page) => page.jsonLdTypes.length === 0).length,
    },
    aeo: {
      pagesWithQuestionHeadings: aeoPages.length,
      pagesWithFaqSchema: faqPages.length,
      pagesWithStructuredData: schemaPages.length,
      averageWordsPerPage: averageWords,
      directAnswerReadiness: readinessScore >= 3 ? 'high' : readinessScore === 2 ? 'medium' : 'low',
      notes: aeoNotes,
    },
    limitations: [
      'Audyt obejmuje maksymalnie ' + maxPages + ' stron w tej sesji i nie zastępuje pełnego crawl budget / renderingu JavaScript.',
      'Nie analizuje danych Search Console, GA4, linków zwrotnych ani profilu Google Business bez podłączonych integracji.',
      'Nie wykonuje logowania, obchodzenia zabezpieczeń, formularzy ani żądań poza pierwotną domenę.',
      'Reguły długości title i description są wskazówkami audytowymi, a nie gwarancją pozycji w Google.',
    ],
  };
}

export async function runPageSpeed(target: unknown, strategyValue: unknown = 'mobile'): Promise<PageSpeedResult> {
  const page = normalizeTarget(target);
  await publicAddresses(page.hostname);
  const strategy: 'mobile' | 'desktop' = strategyValue === 'desktop' ? 'desktop' : 'mobile';
  const endpoint = new URL('https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed');
  endpoint.searchParams.set('url', page.toString());
  endpoint.searchParams.set('strategy', strategy);
  endpoint.searchParams.set('category', 'performance');
  endpoint.searchParams.append('category', 'accessibility');
  endpoint.searchParams.append('category', 'best-practices');
  endpoint.searchParams.append('category', 'seo');
  endpoint.searchParams.set('locale', 'pl');

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    throw new Error('PageSpeed Insights jest niedostępny: ' + (error instanceof Error ? error.message : String(error)));
  }
  const data = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(data?.error?.message || 'PageSpeed Insights HTTP ' + response.status);

  const lighthouse = data?.lighthouseResult ?? {};
  const categories = lighthouse.categories ?? {};
  const audits = lighthouse.audits ?? {};
  const metric = (id: string): number | undefined => {
    const value = audits[id]?.numericValue;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const scores: PageSpeedResult['scores'] = {};
  for (const [key, value] of Object.entries({
    performance: categories.performance?.score,
    accessibility: categories.accessibility?.score,
    bestPractices: categories['best-practices']?.score,
    seo: categories.seo?.score,
  })) {
    if (typeof value === 'number') scores[key as keyof PageSpeedResult['scores']] = Math.round(value * 100);
  }

  const fieldSource = data?.loadingExperience ?? data?.originLoadingExperience;
  const field = fieldSource ? {
    source: data?.loadingExperience ? 'URL' : 'ORIGIN',
    overallCategory: fieldSource.overall_category,
    metrics: Object.fromEntries(Object.entries(fieldSource.metrics ?? {}).map(([key, value]: [string, any]) => [
      key,
      { percentile: value?.percentile, category: value?.category },
    ])),
  } : undefined;

  const opportunities = Object.entries(audits)
    .filter(([id, value]: [string, any]) => value?.details?.type === 'opportunity' && value?.score !== null && value?.score < 0.9)
    .map(([id, value]: [string, any]) => ({
      id,
      title: String(value.title ?? id),
      savingsMs: typeof value.details?.overallSavingsMs === 'number' ? Math.round(value.details.overallSavingsMs) : undefined,
      description: String(value.description ?? '').replace(/\[Learn more\]\([^)]+\)/g, '').slice(0, 600),
    }))
    .sort((a, b) => (b.savingsMs ?? 0) - (a.savingsMs ?? 0))
    .slice(0, 12);

  return {
    url: page.toString(),
    strategy,
    fetchedAt: new Date().toISOString(),
    scores,
    lab: {
      lcpMs: metric('largest-contentful-paint'),
      fcpMs: metric('first-contentful-paint'),
      cls: metric('cumulative-layout-shift'),
      tbtMs: metric('total-blocking-time'),
      speedIndexMs: metric('speed-index'),
    },
    field,
    opportunities,
    limitations: [
      'Wyniki Lighthouse są pomiarem laboratoryjnym dla tego uruchomienia; mogą się zmieniać między próbami.',
      'Dane terenowe CrUX mogą nie być dostępne dla adresu lub domeny; nie należy zastępować ich wynikami laboratoryjnymi.',
      'PageSpeed API nie gwarantuje pozycji w wynikach wyszukiwania.',
    ],
  };
}

export async function getSeoIntegrationStatus(env: NodeJS.ProcessEnv = process.env) {
  const oauth = await googleOAuthManager.status();
  const connected = (keys: string[]) => keys.every((key) => Boolean((env[key] ?? '').trim()));
  const siteUrl = (env.GOOGLE_SEARCH_CONSOLE_SITE_URL ?? '').trim();
  const propertyId = (env.GOOGLE_GA4_PROPERTY_ID ?? '').trim();
  const locationId = (env.GOOGLE_BUSINESS_PROFILE_LOCATION_ID ?? '').trim();
  const hasGsc = (Boolean((env.GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN ?? '').trim())
    || (oauth.connected && oauth.scopes.includes('https://www.googleapis.com/auth/webmasters.readonly')))
    && Boolean(siteUrl);
  const hasGa4 = (Boolean((env.GOOGLE_GA4_ACCESS_TOKEN ?? '').trim())
    || (oauth.connected && oauth.scopes.includes('https://www.googleapis.com/auth/analytics.readonly')))
    && /^\d+$/.test(propertyId);
  const hasSemrush = connected(['SEMRUSH_API_KEY']);
  const hasGbp = (Boolean((env.GOOGLE_BUSINESS_PROFILE_ACCESS_TOKEN ?? '').trim())
    || (oauth.connected && oauth.scopes.includes('https://www.googleapis.com/auth/business.manage')))
    && Boolean(locationId);
  return {
    googleOAuth: oauth,
    searchConsole: { status: hasGsc ? 'CONFIGURED' : 'NOT_CONFIGURED', requiresOAuth: true, siteConfigured: Boolean(siteUrl), configKeys: ['GOOGLE_SEARCH_CONSOLE_SITE_URL'] },
    ga4: { status: hasGa4 ? 'CONFIGURED' : 'NOT_CONFIGURED', requiresOAuth: true, propertyConfigured: /^\d+$/.test(propertyId), configKeys: ['GOOGLE_GA4_PROPERTY_ID'] },
    backlinks: { status: hasSemrush ? 'CONFIGURED' : 'NOT_CONFIGURED', provider: 'Semrush', paidProvider: true, approvalRequiredBeforeQueries: true, configKeys: ['SEMRUSH_API_KEY'] },
    localSeo: { status: hasGbp ? 'CONFIGURED' : 'NOT_CONFIGURED', provider: 'Google Business Profile', requiresOAuth: true, locationConfigured: Boolean(locationId), configKeys: ['GOOGLE_BUSINESS_PROFILE_LOCATION_ID'] },
  };
}

function isoDate(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const timestamp = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return fallback;
  return value;
}

export async function runSearchConsoleReport(input: { startDate?: unknown; endDate?: unknown } = {}) {
  const siteUrl = (process.env.GOOGLE_SEARCH_CONSOLE_SITE_URL ?? '').trim();
  if (!siteUrl) throw new Error('Wymagane jest GOOGLE_SEARCH_CONSOLE_SITE_URL dla zweryfikowanej usługi Search Console.');
  const token = (process.env.GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN ?? '').trim()
    || await googleOAuthManager.accessToken('https://www.googleapis.com/auth/webmasters.readonly');
  const today = new Date();
  const endFallback = new Date(today.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
  const startFallback = new Date(today.getTime() - 31 * 86_400_000).toISOString().slice(0, 10);
  const startDate = isoDate(input.startDate, startFallback);
  const endDate = isoDate(input.endDate, endFallback);
  if (startDate > endDate) throw new Error('Data początkowa nie może być późniejsza niż końcowa.');
  const endpoint = 'https://searchconsole.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(siteUrl) + '/searchAnalytics/query';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ startDate, endDate, dimensions: ['query', 'page', 'device', 'country'], rowLimit: 250 }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(data?.error?.message || 'Search Console API HTTP ' + response.status);
  return { provider: 'Google Search Console', siteUrl, startDate, endDate, rows: Array.isArray(data.rows) ? data.rows : [] };
}

export async function runGa4Report(input: { startDate?: unknown; endDate?: unknown } = {}) {
  const propertyId = (process.env.GOOGLE_GA4_PROPERTY_ID ?? '').trim();
  if (!/^\d+$/.test(propertyId)) throw new Error('Wymagany jest numeryczny GOOGLE_GA4_PROPERTY_ID.');
  const token = (process.env.GOOGLE_GA4_ACCESS_TOKEN ?? '').trim()
    || await googleOAuthManager.accessToken('https://www.googleapis.com/auth/analytics.readonly');
  const today = new Date();
  const endFallback = new Date(today.getTime() - 1 * 86_400_000).toISOString().slice(0, 10);
  const startFallback = new Date(today.getTime() - 28 * 86_400_000).toISOString().slice(0, 10);
  const startDate = isoDate(input.startDate, startFallback);
  const endDate = isoDate(input.endDate, endFallback);
  if (startDate > endDate) throw new Error('Data początkowa nie może być późniejsza niż końcowa.');
  const endpoint = 'https://analyticsdata.googleapis.com/v1beta/properties/' + propertyId + ':runReport';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'conversions' }],
      limit: '250',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(data?.error?.message || 'GA4 Data API HTTP ' + response.status);
  return { provider: 'Google Analytics 4', propertyId, startDate, endDate, dimensionHeaders: data.dimensionHeaders ?? [], metricHeaders: data.metricHeaders ?? [], rows: Array.isArray(data.rows) ? data.rows : [] };
}

export async function runGoogleBusinessProfileAudit() {
  const locationResource = (process.env.GOOGLE_BUSINESS_PROFILE_LOCATION_ID ?? '').trim();
  if (!locationResource) throw new Error('Wymagane jest GOOGLE_BUSINESS_PROFILE_LOCATION_ID, np. locations/123456789.');
  const normalizedResource = locationResource.startsWith('locations/') ? locationResource : 'locations/' + locationResource;
  if (!/^locations\/[A-Za-z0-9_-]+$/.test(normalizedResource)) throw new Error('Niepoprawny GOOGLE_BUSINESS_PROFILE_LOCATION_ID.');
  const token = (process.env.GOOGLE_BUSINESS_PROFILE_ACCESS_TOKEN ?? '').trim()
    || await googleOAuthManager.accessToken('https://www.googleapis.com/auth/business.manage');
  const endpoint = new URL('https://mybusinessbusinessinformation.googleapis.com/v1/' + normalizedResource);
  endpoint.searchParams.set('readMask', 'name,title,storeCode,websiteUri,phoneNumbers,regularHours,specialHours,storefrontAddress,metadata,profile');
  const response = await fetch(endpoint, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(data?.error?.message || 'Google Business Profile API HTTP ' + response.status);
  const missing: string[] = [];
  if (!data.title) missing.push('Nazwa firmy');
  if (!data.websiteUri) missing.push('Adres strony');
  if (!data.phoneNumbers?.primaryPhone) missing.push('Telefon główny');
  if (!data.storefrontAddress?.locality || !data.storefrontAddress?.addressLines?.length) missing.push('Pełny adres lokalizacji');
  if (!data.regularHours?.periods?.length) missing.push('Godziny otwarcia');
  return {
    provider: 'Google Business Profile',
    resource: normalizedResource,
    location: {
      title: data.title,
      websiteUri: data.websiteUri,
      primaryPhone: data.phoneNumbers?.primaryPhone,
      storefrontAddress: data.storefrontAddress,
      regularHours: data.regularHours,
      metadata: data.metadata,
      profile: data.profile,
    },
    missingProfileFields: missing,
    limitations: [
      'To jest odczyt danych wizytówki, nie audyt pozycji w Mapach ani opinii klientów.',
      'Nexus nie zmienił żadnego pola wizytówki. Aktualizacje wymagają osobnej, jawnej zgody.',
    ],
  };
}

