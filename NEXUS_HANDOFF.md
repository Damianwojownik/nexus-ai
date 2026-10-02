# Nexus handoff — aktualny stan

Ten plik jest punktem wejścia dla nowego chatu/agenta. Przed zmianami przeczytaj go oraz najnowszy kod repozytorium.

## Cel
Nexus ma być jednym osobistym AI z ciągłą pamięcią, internetem, głosem, przeglądarką i możliwością przełączania providerów bez utraty kontekstu. Interfejs ma ukrywać techniczne podsystemy; użytkownik rozmawia z Nexus/Luna.

## Providery AI
- Primary w aktualnym buildzie Floot: chmurowy model Floot `glm-5`.
- Gdy kończą się kredyty chmury, aplikacja zwraca sygnał `LOCAL_FALLBACK_REQUIRED`.
- Browser Bridge protocol v2 potrafi wtedy rozmawiać bezpośrednio z lokalnym Ollama na `127.0.0.1:11434`.
- Preferowany darmowy model: `llama3.2:3b`.
- Skrypt `scripts/connect-ai-stack-windows.ps1 -InstallMissing` instaluje/uruchamia stos i preferuje Llama 3.2 3B; ma lżejszy fallback qwen2.5:1.5b.
- Pamięć/kontekst jest po stronie Nexusa, więc zmiana providerów nie ma zerować rozmowy.

## Internet
Aktualny build Floot ma niezależne od kredytów AI narzędzia:
- `web_search` — DuckDuckGo HTML,
- `weather` — Open-Meteo,
- `provider_status`.
Test 2026-10-02: weather i web_search zwracały HTTP 200.

## Browser Bridge / programy
- Chrome/Edge extension, protocol v2.
- Bezpieczne read/open/click/type/close; akcje modyfikujące stronę wymagają zgody.
- Blokowane: hasła, OTP, płatności, logowanie, usuwanie.
- Ten sam bridge zapewnia lokalny Ollama fallback.
- Dzięki pracy przez zalogowane karty może obsługiwać m.in. GitHub/Canva bez przejmowania haseł; API connectors są osobnym kanałem.

## Connectory API
Floot ma registry: GitHub, Canva i custom przez `NEXUS_CONNECTORS_JSON`.
Tokeny nie są dziedziczone z ChatGPT — muszą być osobno skonfigurowane w środowisku aplikacji. Connector read działa read-only.

## Pamięć
Aktualny frontend Floot zapisuje ostatnie 20 wpisów rozmowy w localStorage (`nexus-chat-memory-v1`) i przekazuje ten sam kontekst zarówno chmurze, jak i lokalnej Llamie. Pełny Agent Core ma dodatkowo DB memory helpers.

## Avatar
- Nexus i Luna to osobne selectable personas.
- Docelowo Nexus ma być gadającą realistyczną twarzą, nie geometrycznym manekinem.
- W repo istnieje instalator FasterLivePortrait dla Windows i GTX 970: `scripts/setup-faster-liveportrait-windows.ps1`.
- W projekcie Floot jest przygotowany `static/nexus_flp_bridge.txt` (FastAPI bridge do FasterLivePortrait).
- Nie nazywać amplitude/estimated visemes „true lip-sync”.

## Ezostylia
Źródłowe repo `Damianwojownik/ezostylia` pozostaje nietknięte. Do Nexusa kopiujemy tylko potrzebne mechanizmy. W Floot są już kopie referencyjne m.in. LiveAvatar, customEngine, Human/Mixamo, friend live/core, pet rig, arena, Feniks/ShadowVoiceCall i face-video.

## Aktualny Floot
Project ID: `155877bd-a916-4527-8a1f-63d8e09ecf79`.
Kluczowe pliki:
- `helpers/nexusModelRouter.tsx`
- `helpers/nexusServerToolContract.tsx`
- `helpers/nexusLocalOllama.tsx`
- `helpers/nexusBrowserBridge.tsx`
- `helpers/nexusExtensionBackground.tsx`
- `endpoints/nexus/chat_POST.ts`
- `endpoints/nexus/tool_POST.ts`
- `pages/_index.tsx`

## Zasada kontynuacji
Nie usuwaj ani nie modyfikuj Ezostylii przy migracji. Nie udawaj, że lokalny Ollama/FasterLivePortrait działa, dopóki proces nie odpowie z komputera użytkownika. Następny agent ma najpierw sprawdzić bieżący stan repo/Floot, a dopiero potem edytować.
