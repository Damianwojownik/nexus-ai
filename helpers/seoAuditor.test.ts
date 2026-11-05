import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPublicSite, getSeoIntegrationStatus, parseRobots, runPageSpeed, runSemrushBacklinksOverview, runSemrushBacklinkCompetitors, runSemrushKeywordMetrics } from './seoAuditor.ts';

test('robots.txt applies only wildcard user-agent groups and preserves their sitemap directives', () => {
  const parsed = parseRobots(`User-agent: Googlebot
Disallow: /private-google/

User-agent: *
Disallow: /private/
Disallow: /draft/
Sitemap: https://example.com/sitemap.xml

User-agent: Bingbot
Disallow: /bing-only/
`);
  assert.deepEqual(parsed.disallow, ['/private/', '/draft/']);
  assert.deepEqual(parsed.sitemaps, ['https://example.com/sitemap.xml']);
  assert.equal(parsed.disallowsAll, false);

  const blocked = parseRobots('User-agent: *\nDisallow: /');
  assert.equal(blocked.disallowsAll, true);
});

test('Semrush paid endpoints reject requests before network access unless explicit per-query approval is true', async () => {
  await assert.rejects(
    () => runSemrushBacklinksOverview('https://example.com', false),
    /45 jednostek API/i,
  );
  await assert.rejects(
    () => runSemrushKeywordMetrics({ keyword: 'seo tools', country: 'DE', paidQueryApproved: false }),
    /20 jednostek API/i,
  );
  await assert.rejects(
    () => runSemrushBacklinkCompetitors('https://example.com', false),
    /200 jednostek API/i,
  );
  await assert.rejects(
    () => runSemrushKeywordMetrics({ keyword: 'seo tools', country: 'DE', paidQueryApproved: true }),
    /SEMRUSH_API_KEY/i,
  );
});

test('public SEO crawler rejects private, loopback and credential-bearing targets before connecting', async () => {
  await assert.rejects(() => auditPublicSite('http://127.0.0.1'), /lokalny|prywatn|zarezerwowan/i);
  await assert.rejects(() => auditPublicSite('http://10.0.0.8'), /prywatn|zarezerwowan/i);
  await assert.rejects(() => auditPublicSite('http://192.168.1.1'), /prywatn|zarezerwowan/i);
  await assert.rejects(() => auditPublicSite('http://user:pass@example.com'), /logowania/i);
  await assert.rejects(() => auditPublicSite('http://example.com:8080'), /porty/i);
  await assert.rejects(() => runPageSpeed('http://localhost'), /lokalny|zarezerwowan/i);
});

test('integration health reports availability without exposing secret values', async () => {
  const status = await getSeoIntegrationStatus({
    GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN: 'secret-gsc-token',
    GOOGLE_SEARCH_CONSOLE_SITE_URL: 'sc-domain:example.com',
    GOOGLE_GA4_ACCESS_TOKEN: 'secret-ga-token',
    GOOGLE_GA4_PROPERTY_ID: '123456789',
    SEMRUSH_API_KEY: 'secret-semrush-key',
    GOOGLE_BUSINESS_PROFILE_ACCESS_TOKEN: 'secret-gbp-token',
    GOOGLE_BUSINESS_PROFILE_LOCATION_ID: 'locations/42',
  } as NodeJS.ProcessEnv);

  assert.equal(status.searchConsole.status, 'CONFIGURED');
  assert.equal(status.ga4.status, 'CONFIGURED');
  assert.equal(status.backlinks.status, 'CONFIGURED');
  assert.equal(status.backlinks.approvalRequiredBeforeQueries, true);
  assert.equal(status.localSeo.status, 'CONFIGURED');
  assert.equal(JSON.stringify(status).includes('secret-'), false);
});

test('unconfigured integrations are explicitly reported rather than fabricated', async () => {
  const status = await getSeoIntegrationStatus({});
  assert.equal(status.searchConsole.status, 'NOT_CONFIGURED');
  assert.equal(status.ga4.status, 'NOT_CONFIGURED');
  assert.equal(status.backlinks.status, 'NOT_CONFIGURED');
  assert.equal(status.localSeo.status, 'NOT_CONFIGURED');
});
