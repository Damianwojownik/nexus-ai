import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANY_ROLES, companyMemoryKey, companyProjectContext, createCompanyProfile, normalizeCompanyWebsite, parseCompanyProfile } from './companyWorkspace.ts';
import { BrowserMemoryBackend, MemoryStore } from './memoryStore.ts';

const draft = {
  name: 'Firma A', description: 'Naprawa rowerow', website: 'rowery.example.com',
  goals: 'Wiecej lokalnych klientow', market: 'Polska, polski',
};

test('company profile validates and normalizes without Ezostylia defaults', () => {
  const profile = createCompanyProfile(draft, 'company-a');
  assert.equal(profile.website, 'https://rowery.example.com/');
  assert.equal(profile.version, 1);
  assert.deepEqual(parseCompanyProfile(JSON.parse(JSON.stringify(profile))), profile);
  assert.throws(() => createCompanyProfile({ ...draft, name: ' ' }));
  assert.throws(() => createCompanyProfile({ ...draft, goals: 'a'.repeat(1001) }));
  assert.throws(() => createCompanyProfile({ ...draft, description: '\u0000x' }));
  assert.throws(() => parseCompanyProfile({ ...profile, version: 2 }));
  assert.throws(() => parseCompanyProfile({ ...profile, id: '../other' }));
  assert.throws(() => parseCompanyProfile({ ...profile, description: false }));
});

test('company website excludes credentials, private literals and non-web schemes', () => {
  for (const website of ['javascript:alert(1)', 'file:///C:/secret', 'https://user:secret@example.com',
    'http://127.0.0.1', 'http://2130706433', 'http://[::1]', 'http://localhost', 'http://foo.local',
    'https://example.com:8788', 'https://foo.internal']) {
    assert.throws(() => normalizeCompanyWebsite(website), website);
  }
  assert.equal(normalizeCompanyWebsite('https://example.com/path#section'), 'https://example.com/path');
});

test('company context contains actual company and explicit execution boundaries', () => {
  const profile = createCompanyProfile(draft, 'company-a');
  const context = companyProjectContext(profile);
  assert.ok(context.includes(JSON.stringify(profile)));
  assert.equal(COMPANY_ROLES.length, 5);
  for (const role of COMPANY_ROLES) assert.ok(context.includes(role.name));
  assert.ok(context.includes('NIE oznacza odczytanej'));
  assert.ok(context.includes('Nie publikuj'));
  assert.ok(context.includes('nie dowodem uruchomienia'));
  assert.notEqual(companyMemoryKey(profile), companyMemoryKey(createCompanyProfile(draft, 'company-b')));
});

test('separate company memories persist and never read general or other company history', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
  try {
    const general = new MemoryStore(new BrowserMemoryBackend());
    const aKey = companyMemoryKey(createCompanyProfile(draft, 'company-a'));
    const a = new MemoryStore(new BrowserMemoryBackend(aKey));
    const b = new MemoryStore(new BrowserMemoryBackend(companyMemoryKey(createCompanyProfile(draft, 'company-b'))));
    const entry = { kind: 'durable' as const, category: 'tasks' as const, tags: ['test'], text: 'rowery confidential' };
    await general.saveMemory({ ...entry, text: 'Ezostylia confidential' });
    await a.saveMemory(entry);
    assert.equal((await a.searchMemory('rowery')).length, 1);
    assert.equal((await b.searchMemory('rowery')).length, 0);
    assert.equal((await a.searchMemory('Ezostylia')).length, 0);
    assert.equal((await general.searchMemory('rowery')).length, 0);
    const restored = new MemoryStore(new BrowserMemoryBackend(aKey));
    assert.equal((await restored.searchMemory('rowery')).length, 1);
    storage.set('corrupt-company', '{"text":"not a memory array"}');
    const corrupt = new MemoryStore(new BrowserMemoryBackend('corrupt-company', true));
    await assert.rejects(corrupt.getRelevantMemories('rowery'), /nieprawidlowy format/);
    storage.set('broken-json', '{');
    const broken = new MemoryStore(new BrowserMemoryBackend('broken-json', true));
    await assert.rejects(broken.getRelevantMemories('rowery'), SyntaxError);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
