# Nexus AI — niezależny produkt i architektura

## Twarda granica: Ezostylia pozostaje nietknięta

Nexus jest osobnym projektem. Nie kopiuje kodu, interfejsu, zasobów, bazy danych, konfiguracji ani kluczy Ezostylia. Nie wywołuje jej API ani MCP jako wymaganej zależności. W szczególności nie modyfikuje domeny, repozytorium, backendu, danych ani konfiguracji Ezostylia.

W przyszłości użytkownik może osobno zatwierdzić dowolną, oficjalną integrację z usługą zewnętrzną. Taka integracja jest opcjonalna, wymienna i nie może być warunkiem działania podstawowego Nexusa.

## Docelowy produkt

Nexus ma być jednym asystentem konwersacyjnym. Użytkownik opisuje cel w jednym czacie; Nexus planuje zadanie, dobiera narzędzia i specjalistów, wykonuje niezależne kroki równolegle, weryfikuje wyniki i zwraca odpowiedź wraz z artefaktami. Użytkownik nie musi znać nazw agentów, endpointów ani dostawców.

### Warstwy

1. **Chat UI** — pełny, trwały zapis rozmów, wiele wątków/projektów, streaming, załączniki, głos, wykresy/tabele i podglądy plików.
2. **Nexus Core / Orchestrator** — planowanie, wybór umiejętności, rozbijanie zadań, priorytety, zależności, równoległe wykonanie, retry z limitem i końcowa synteza.
3. **Tool Registry** — jedyny katalog narzędzi; każde narzędzie ma opis, schemat wejścia, status, koszt, zakres, transport i klasę uprawnień. Model nigdy nie otrzymuje swobodnego dostępu do powłoki ani plików.
4. **Connector Gateway** — wymienne konektory MCP/HTTP oraz integracje natywne. Sekrety pozostają wyłącznie po stronie serwera.
5. **AI Model Router** — najpierw lokalne, sprawdzone modele; opcjonalne modele zewnętrzne dopiero po skonfigurowaniu i zgodzie użytkownika. Brak automatycznego płatnego fallbacku.
6. **Memory & Project Store** — dane rozmów, projekty i pamięć są własnością Nexusa, a nie modelu lub konektora.
7. **Artifact Engine** — pliki, PDF, CSV/XLSX, wykresy, obrazy i raporty z metadanymi źródeł.
8. **Independent Reviewer** — sprawdza fakty, kompletność, uprawnienia i zgodność rezultatu z celem, zanim Nexus zakończy zadanie.

### Zespół specjalistów

- Nexus Planner — rozpoznanie celu, plan i delegowanie.
- Web Researcher — wyszukiwanie i weryfikacja źródeł.
- Technical SEO — crawler, indeksacja, statusy, canonical, robots/sitemap, linki i Core Web Vitals.
- Keyword & Competitor Analyst — intencje, klastry fraz i luki konkurencji.
- Content & AEO — treści, FAQ, dane strukturalne i odpowiedzi dla wyszukiwarek/AI.
- Analytics Analyst — Search Console i GA4 po autoryzacji użytkownika.
- Backlink Analyst — dane z uprawnionych źródeł zewnętrznych; nie udaje danych, których crawler nie zbiera.
- Local SEO — GBP, NAP i widoczność lokalna po odpowiednich uprawnieniach.
- Developer / File Analyst — kod, załączniki i dokumenty w jawnie przyznanym workspace.
- Independent Reviewer — niezależna kontrola i raport ograniczeń.

Role są definicjami specjalizacji. Nie wolno raportować ich jako działających, dopóki nie mają rzeczywistego wykonawcy, przydzielonego zadania i potwierdzonego wyniku.

## Kontrakt wykonania narzędzi

1. Planner wybiera wyłącznie narzędzia obecne w aktualnym katalogu i dostępne dla bieżącego użytkownika.
2. Argumenty są walidowane względem schematu po stronie serwera; opisy narzędzi i wyniki zewnętrzne są traktowane jako niezaufane dane.
3. Odczyty z jawnie zaufanej listy mogą działać automatycznie. Zapis, wysyłka, publikowanie, zakupy, instalacje, kasowanie i działanie o niejasnym skutku wymagają wyraźnej zgody użytkownika.
4. Każde zadanie ma limit kroków, czasu, rozmiaru danych i prób. Anulowanie z UI przerywa dalsze działania.
5. Rezultat narzędzia nie jest instrukcją dla modelu. Nexus rozdziela cytowane dane, wynik weryfikacji i hipotezę.
6. Każde stwierdzenie o wykonaniu działania musi mieć potwierdzenie po stronie narzędzia.

## Bezpieczeństwo i hosting

- Domyślny lokalny Hub nasłuchuje wyłącznie na loopback. Nie wystawiać go publicznie bez uwierzytelniania, CSRF/origin policy, rate limits i testu bezpieczeństwa.
- Zdalne konektory wymagają HTTPS, walidacji URL/DNS/IP przeciw SSRF, limitów czasu/odpowiedzi oraz sekretów po stronie serwera.
- Nie umieszczać kluczy w `VITE_*`, repozytorium, przeglądarce ani logach.
- Crawling publicznych stron respektuje robots/rate limits i blokuje localhost, prywatne zakresy IP, metadata endpoints oraz przekierowania do sieci prywatnych.
- Nie wykonywać arbitralnych poleceń powłoki ani dowolnych instalacji.
- Hosting jest niezależny od dostawcy. Najpierw lokalny runtime i darmowe warianty; żaden płatny plan, kredyt, model lub zasób nie może być aktywowany bez odrębnej zgody.

## Granica pomiędzy obecnym stanem a celem

Repozytorium zawiera już część lokalnego runtime, routery modeli, pamięć, wyszukiwanie, pogodę, pracę na plikach, generowanie mediów i Agent Hub. Są też eksperymentalne gałęzie konektorów i agentów.

Nie oznacza to jeszcze kompletnego produktu. Wymagają dalszej implementacji i testów: trwały interfejs rozmowy, ogólny pętlowy tool-calling, hierarchiczny scheduler niezależnych agentów, kontrola zgód, pełny katalog narzędzi, trwałe przechowywanie wątków i artefaktów oraz bezpieczny tryb hostowany. Funkcje SEO/AEO, Search Console, GA4, backlinki i GBP nie mogą być oznaczane jako gotowe bez rzeczywistego źródła danych i testu integracyjnego.

## Kolejność realizacji

1. Stabilny, niezależny rdzeń: czat z historią, lokalny Hub, pamięć i lokalny model.
2. Bezpieczny katalog narzędzi i ujednolicony cykl: plan → wybór → walidacja → zgoda → wykonanie → weryfikacja.
3. Konektory MCP i natywne integracje niezależne od Ezostylia.
4. Scheduler hierarchii agentów, równoległość i niezależny reviewer.
5. Narzędzia SEO/AEO, analityka i raporty/artefakty.
6. Oddzielny, zabezpieczony hosting i kopie zapasowe — dopiero po sprawdzeniu kosztów i uzyskaniu zgody użytkownika.
