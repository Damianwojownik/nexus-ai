# Luna Nexus na telefonie (Android i iPhone)

To **instalowalna aplikacja internetowa (PWA)**, nie samodzielny plik APK.
Interfejs i animowana Luna działają na telefonie, a **Ollama, Codex, pamięć, narzędzia i Agent Hub pozostają na komputerze**. Komputer musi być włączony.

## Prywatny dostęp

Bramka mobilna nasłuchuje **tylko na 127.0.0.1:5190**; dostęp z telefonu odbywa się przez prywatny HTTPS Tailscale Serve. Telefon musi podać kod parowania widoczny w terminalu bramki.

**Nigdy nie uruchamiaj Tailscale Funnel dla Nexusa** ani nie udostępniaj portów 8789 i 11434 bezpośrednio w Wi-Fi lub internecie.

## Uruchomienie

1. Zainstaluj Tailscale (https://tailscale.com/download) na Windows i telefonie. Zaloguj oba urządzenia do tego samego prywatnego tailnetu; włącz HTTPS w ustawieniach Tailscale, jeśli zostaniesz o to poproszony.
2. Otwórz folder C:\Users\damian\luna-nexus-app w VS Code.
3. Ustaw model w lokalnym pliku .env.local (poza Gitem):

       VITE_OLLAMA_MODEL=qwen2.5:1.5b

4. Przygotuj aplikację:

       npm ci
       npm run build

5. Uruchom Ollamę na Windows i sprawdź ją poleceniem ollama ps.
6. Jeśli Agent Hub nie działa jeszcze na porcie 8789, uruchom go w terminalu 1:

       $env:NEXUS_AGENT_HUB_PORT="8789"
       npm run hub

7. Uruchom mobilną bramkę w terminalu 2:

       $env:NEXUS_AGENT_HUB_PORT="8789"
       node scripts/mobile-server.mjs

   Terminal wyświetli **kod parowania** oraz adres http://127.0.0.1:5190. Zostaw go otwarty.
8. Na Windows, gdy Tailscale jest połączony, wykonaj w terminalu 3:

       tailscale serve --bg 5190
       tailscale serve status

   Odczytaj **swój prawdziwy adres HTTPS** z wyników Tailscale Serve (przykładowy format: https://twoj-komputer.twoj-tailnet.ts.net/).
9. Na telefonie uruchom Tailscale, otwórz adres HTTPS z poprzedniego kroku i wpisz kod parowania z terminala.

## Instalowanie na ekranie głównym

- **Android (Chrome):** menu ⋮ → Zainstaluj aplikację lub Dodaj do ekranu głównego.
- **iPhone (Safari):** Udostępnij → Dodaj do ekranu początkowego.

Luna wygląda jak aplikacja, ale nadal wymaga działającego komputera i Tailscale. Historia czatu przeglądarki telefonu nie synchronizuje się automatycznie z historią Windows. Mikrofon i automatyczne odtwarzanie głosu zależą od uprawnień przeglądarki.

## Diagnostyka i zatrzymanie

- Na komputerze: curl.exe http://127.0.0.1:5190/ powinien pokazać formularz parowania.
- Agent Hub: curl.exe http://127.0.0.1:8789/api/health
- Ollama: curl.exe http://127.0.0.1:11434/api/tags
- Nieautoryzowane żądania POST do /api/... i /ollama/... powinny zwracać 401.
- Zatrzymanie udostępniania: tailscale serve --https=443 off
- Kod parowania zmienia się przy restarcie bramki i nie jest zapisany w Gicie.

Nie kopiuj tokenów ChatGPT/Codex na telefon — CLI działa na komputerze.

## Ograniczenia

To wersja PWA, **nie plik APK ani aplikacja w Google Play/App Store**. Nie działa samodzielnie ani offline. Kod mobilny nie korzysta z Ezostylii ani z płatnych kluczy API.
