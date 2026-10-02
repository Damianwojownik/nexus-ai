import type { MemoryStore } from './memoryStore.ts';

const durableSeeds = [
  {
    text: 'Nexus jest głównym interfejsem rozmowy. Narzędzia, modele, GitHub, internet i projekty mają działać za jednym orkiestratorem.',
    category: 'identity/config' as const,
    tags: ['nexus','orchestrator'],
  },
  {
    text: 'Praca nad aplikacją jest iteracyjna: zbierz brakujące wymagania, pokaż krótki plan, po potwierdzeniu zbuduj projekt, sprawdź zapis i przyjmuj kolejne poprawki.',
    category: 'decisions' as const,
    tags: ['builder','coding','iteration'],
  },
  {
    text: 'Aktualne informacje pobieraj przez capability internetu. Wyszukiwanie korzysta z DuckDuckGo, a pogoda z Open-Meteo.',
    category: 'identity/config' as const,
    tags: ['internet','search','weather'],
  },
  {
    text: 'Gdy zdalny model jest niedostępny, Nexus ma kontynuować na lokalnym Ollama, jeśli lokalny model działa.',
    category: 'decisions' as const,
    tags: ['ollama','fallback','router'],
  },
  {
    text: 'Pamięć projektu ma przechowywać wymagania, decyzje, zadania i wyniki tak, aby kolejna rozmowa mogła kontynuować pracę bez zaczynania od zera.',
    category: 'projects' as const,
    tags: ['memory','projects','continuity'],
  },
  {
    text: 'GitHub służy jako trwały most kodu i historii zmian między Nexus, Codex i innymi agentami.',
    category: 'projects' as const,
    tags: ['github','codex','handoff'],
  },
];

export async function seedNexusMemory(memory: MemoryStore): Promise<void> {
  for (const seed of durableSeeds) {
    await memory.saveMemory({
      kind: 'durable',
      text: seed.text,
      category: seed.category,
      tags: seed.tags,
      owner: 'nexus',
      scope: 'system',
      source: 'bootstrap',
      relevance: 0.95,
      sensitive: false,
    });
  }
}
