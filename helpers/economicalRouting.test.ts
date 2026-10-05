import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider } from './economicalRouting.ts';

test('economical routing reserves Astra for questions, analysis and decisions', () => {
  for (const text of ['Czy to działa', 'Przeanalizuj SEO', 'Podejmij decyzję', 'Zastanów się', 'Jak poprawić stronę', 'Porównaj oferty', 'Co wybrać?', 'Zredaguj podany tekst', 'Finalna redakcja', 'Wykonaj audyt SEO', 'Sprawdź fakty']) {
    assert.equal(resolveProvider('economy', text), 'chatgpt-plan', text);
  }
  for (const text of ['Napisz szkic artykułu', 'Popraw literówki', 'Dodaj tytuł i opis meta', 'Narysuj diagram']) {
    assert.equal(resolveProvider('economy', text), 'ollama', text);
  }
  assert.equal(resolveProvider('ollama', 'Podejmij decyzję'), 'ollama');
  assert.equal(resolveProvider('copilot', 'Czy to działa?'), 'copilot');
  assert.equal(resolveProvider('chatgpt-plan', 'Popraw tekst'), 'chatgpt-plan');
  assert.equal(resolveProvider('auto', 'Napisz tekst'), 'auto');
});
