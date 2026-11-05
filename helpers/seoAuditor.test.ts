import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPublicSite, getSeoIntegrationStatus, runPageSpeed } from './seoAuditor.ts';

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
