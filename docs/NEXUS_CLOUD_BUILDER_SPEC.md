PRACUJEMY NAD NEXUS AI.

GŁÓWNY CEL:
Zbuduj w Nexusie własny, niezależny CLOUD BUILDER / NO-CODE BUILDER do tworzenia stron internetowych i aplikacji z języka naturalnego.

Użytkownik nie ma pisać kodu.
Ma móc powiedzieć np.:

„Zbuduj mi luksusową stronę restauracji. Czarny styl, menu, galeria, rezerwacja stolika i panel administracyjny.”

Nexus ma:
1. zrozumieć wymagania,
2. zaplanować projekt,
3. stworzyć strukturę,
4. wygenerować frontend/backend,
5. utworzyć bazę danych, jeśli potrzebna,
6. uruchomić podgląd,
7. przetestować,
8. poprawić błędy,
9. zapamiętać projekt,
10. pozwolić użytkownikowi zmieniać stronę zwykłą rozmową,
11. wersjonować zmiany,
12. umożliwiać później GitHub/deploy.

NIE BUDUJ RÓWNOLEGŁEGO SYSTEMU OBOK NEXUSA.
BUILDER MUSI BYĆ CZĘŚCIĄ GŁÓWNEGO NEXUSA.

==================================================
1. ZASADY BEZWZGLĘDNE
==================================================

Główne repozytorium:
Damianwojownik/nexus-ai

NIE MODYFIKUJ:
Damianwojownik/ezostylia

Ezostylia może służyć wyłącznie jako inspiracja architektoniczna/wizualna, jeśli będzie potrzebna.

Nie niszcz istniejących:
- avatarów,
- silników video,
- FasterLivePortrait,
- VACE,
- render pipeline,
- Agent Hub,
- ChatGPT integration,
- Ollama fallback,
- pamięci agentów.

Codex może pracować równolegle nad silnikami postaci/video.
Cloud Builder ma być od nich logicznie oddzielony, ale później możliwy do połączenia.

Nie kupuj:
- hostingu,
- kredytów,
- API,
- domen,
- subskrypcji,
- płatnych usług

bez wyraźnej zgody użytkownika.

Nie wykonuj płatnego deploymentu.

Nie twierdź, że coś działa, dopóki nie ma testu lub rzeczywistego dowodu działania.

==================================================
2. DOCELOWA ARCHITEKTURA NEXUSA
==================================================

Docelowa hierarchia:

USER
↓
NEXUS MAIN BRAIN
↓
PROJECT CONTEXT
↓
PLANNER AGENT
↓
DESIGNER AGENT
↓
BUILDER AGENT
↓
CODER / CODEX AGENT
↓
TESTER AGENT
↓
REVIEWER AGENT
↓
PREVIEW
↓
GITHUB / DEPLOYMENT

Wszystkie agenty korzystają ze wspólnego kontekstu projektu.

NIE twórz osobnych, odizolowanych pamięci dla każdego agenta.

Nexus jest nadrzędnym mózgiem.

Agenci są wykonawcami.

==================================================
3. PAMIĘĆ NEXUSA
==================================================

W projekcie istnieje już fundament:

agent_memories
conversation_memory_reads
standing_instructions
agent_conversations
agent_messages

Używaj istniejącego systemu agent memory.

NIE twórz drugiego konkurencyjnego systemu pamięci.

Nexus powinien mieć:

GLOBAL MEMORY
- preferencje użytkownika,
- ogólne zasady,
- stałe decyzje architektoniczne.

PROJECT MEMORY
- informacje dotyczące konkretnego projektu,
- stack technologiczny,
- styl strony,
- komponenty,
- decyzje,
- API,
- baza danych,
- aktualne zadania,
- problemy,
- historia ważnych zmian.

Przykład:

Nexus Memory
├── User Preferences
├── Architecture
├── Projects
│   ├── Restaurant App
│   │   ├── Design
│   │   ├── Features
│   │   ├── Database
│   │   ├── Decisions
│   │   └── Known Issues
│   └── Shop App
└── Tools

Każdy projekt musi być powiązany ze swoim project memory.

Przed wykonaniem większej zmiany Nexus powinien odczytać odpowiednią pamięć projektu.

Po trwałej decyzji powinien ją zapisać.

Nie zapisuj każdego zdania rozmowy jako pamięć trwałą.

==================================================
4. PROJECT SYSTEM
==================================================

Dodaj warstwę projektów.

Projekt powinien posiadać minimum:

id
name
slug
description
status
framework
created_at
updated_at

Dodatkowo:

project files
project tasks
project versions / snapshots
project preview state
project build logs
project test logs

Można użyć tabel typu:

nexus_projects
nexus_project_files
nexus_project_tasks
nexus_project_snapshots
nexus_project_runs

Ale najpierw sprawdź istniejącą architekturę i NIE duplikuj tabel, jeśli projekt ma już podobne struktury.

==================================================
5. NO-CODE BUILDER UX
==================================================

Użytkownik powinien widzieć prosty interfejs.

Główne elementy:

A. CHAT WITH NEXUS

Pole rozmowy.

Przykłady:

„Stwórz stronę fotografa.”

„Dodaj sekcję ceny.”

„Zmień tło na ciemne.”

„Dodaj logowanie Google.”

„Przenieś formularz niżej.”

„Dodaj bazę klientów.”

„Cofnij ostatnią zmianę.”

B. LIVE PREVIEW

Po prawej stronie:

działająca aplikacja / strona.

Zmiany powinny być widoczne bez ręcznego kopiowania kodu.

C. FILE / PROJECT TREE

Opcjonalny tryb zaawansowany:

src
components
pages
api
database
assets

Normalny użytkownik nie musi tego dotykać.

D. PROJECT STATUS

Np.:

Planning
Building
Testing
Ready
Error

E. BUILD LOG

Czytelne komunikaty:

Planner complete
Homepage generated
Database schema created
Tests running
Preview ready

Bez zalewania użytkownika niepotrzebnym technicznym logiem.

==================================================
6. NATURAL LANGUAGE → APP
==================================================

Przykład:

USER:

„Zbuduj mi stronę salonu kosmetycznego.
Ma być elegancka, biała i złota.
Strona główna, usługi, cennik, galeria, kontakt i rezerwacja.”

NEXUS powinien stworzyć wewnętrzny PROJECT PLAN:

PROJECT:
Beauty Salon

PAGES:
/
services
pricing
gallery
contact
booking

FEATURES:
responsive design
booking form
admin-ready database structure

STYLE:
luxury
white
gold
minimal

Następnie Planner przekazuje zadania Builderowi.

==================================================
7. PLANNER AGENT
==================================================

Planner NIE pisze całego kodu.

Planner tworzy:

- strukturę projektu,
- listę funkcji,
- listę stron,
- komponenty,
- zależności,
- plan bazy,
- kolejność prac.

Powinien dzielić większe zadania na małe.

Przykład:

TASK 1
Create layout

TASK 2
Create navigation

TASK 3
Create homepage

TASK 4
Create booking form

TASK 5
Create database schema

TASK 6
Run tests

==================================================
8. DESIGNER AGENT
==================================================

Designer odpowiada za:

- layout,
- spacing,
- typography,
- colors,
- responsive design,
- reusable components,
- consistency.

Designer powinien wygenerować DESIGN SPEC przed większym buildem.

Np.:

background
surface
primary
secondary
text
borderRadius
spacing scale
font scale

Nie hardcoduj przypadkowych wartości w setkach miejsc.

Używaj spójnego design systemu.

==================================================
9. BUILDER AGENT
==================================================

Builder realizuje plan.

Builder może delegować ciężką pracę programistyczną do Codera/Codex.

Builder odpowiada za:

- tworzenie plików,
- aktualizacje plików,
- składanie komponentów,
- integrację backend/frontend,
- uruchamianie preview.

Builder nie może nadpisywać całego projektu, jeśli potrzebna jest drobna zmiana.

Zmiana:

„Zwiększ logo”

powinna zmienić właściwy komponent, a nie regenerować całą aplikację.

==================================================
10. CODER / CODEX
==================================================

Coder wykonuje precyzyjne operacje programistyczne.

Przed zmianą:

1. odczytaj odpowiednie pliki,
2. ustal zależności,
3. wykonaj minimalną potrzebną zmianę,
4. sprawdź typecheck,
5. uruchom odpowiednie testy.

Nie przepisuj całych plików bez potrzeby.

Nie usuwaj istniejącej funkcjonalności.

==================================================
11. TESTER AGENT
==================================================

Każdy większy build powinien mieć automatyczne sprawdzenie.

Tester:

- typecheck,
- build,
- unit tests,
- smoke test,
- route check,
- API validation.

Jeśli możliwe:

sprawdzenie czy preview rzeczywiście odpowiada.

Tester zwraca:

PASS

lub

FAIL:
dokładny błąd
plik
linia
proponowany zakres poprawki

==================================================
12. REVIEWER AGENT
==================================================

Reviewer nie przepisuje projektu.

Sprawdza:

- czy wymagania użytkownika zostały wykonane,
- czy aplikacja się buduje,
- czy nie powstały oczywiste regresje,
- czy design jest spójny,
- czy nie ma nieużywanych elementów,
- czy Builder nie wykonał czegoś poza zakresem.

Dopiero wtedy status:

READY

==================================================
13. SNAPSHOTS / VERSIONING
==================================================

To bardzo ważne.

Przed większą zmianą:

snapshot.

Po udanej zmianie:

nowa wersja.

Powinna istnieć możliwość:

„Cofnij ostatnią zmianę.”

„Wróć do wersji sprzed dodania sklepu.”

Nie nadpisuj dobrego projektu bez możliwości rollback.

==================================================
14. ERROR RECOVERY
==================================================

Jeśli etap się nie uda:

NIE zaczynaj wszystkiego od początku.

Przykład:

Planning ✅
Design ✅
Frontend ✅
Database ✅
Tests ❌

Nexus powinien naprawić TEST / problematyczny komponent.

Nie regenerować projektu od zera.

Ta sama zasada później obowiązuje AI Video Studio.

==================================================
15. CLOUD WORKSPACE
==================================================

Projekt musi mieć izolowany workspace.

Nexus powinien potrafić:

- tworzyć pliki,
- czytać pliki,
- edytować pliki,
- usuwać pliki,
- uruchamiać komendy,
- uruchamiać build,
- uruchamiać testy,
- uruchamiać dev server,
- odczytywać logi.

Najpierw sprawdź, jakie natywne mechanizmy Floot są już dostępne.

Jeśli istnieje native self-edit / project editing / workspace API:
preferuj istniejący mechanizm.

NIE buduj własnego filesystem emulatora, jeśli platforma posiada właściwy workspace.

==================================================
16. PREVIEW
==================================================

Po buildzie Nexus powinien wygenerować działający preview.

Użytkownik widzi:

LIVE APP

Nie tylko screenshot.

Builder powinien znać:

preview URL
preview status
build status

Jeśli preview nie działa:

sprawdź logi przed zgadywaniem.

==================================================
17. GITHUB
==================================================

GitHub jest warstwą eksportu i wersjonowania.

Projekt powinien później umożliwiać:

Create Repository
Commit
Push
Pull
Diff

Ale NIE rób automatycznie publicznych repozytoriów.

Nie publikuj niczego bez zgody użytkownika.

==================================================
18. DEPLOYMENT
==================================================

Dodaj architekturę pod przyszły deployment.

Np.:

Deploy Adapter

ale na tym etapie:

NIE kupuj hostingu
NIE uruchamiaj płatnych zasobów

Deployment może pozostać disabled / not configured.

==================================================
19. AI VIDEO STUDIO
==================================================

Cloud Builder musi być przygotowany na późniejsze połączenie z Nexus AI Video Studio.

Docelowe silniki:

Nexus Body Engine
→ VACE

Nexus Face Engine
→ FasterLivePortrait

Nexus Lip Engine
→ MuseTalk

Nexus Cinema Engine
→ Wan2.2

Nexus Voice Engine
→ polski TTS

Nexus Cutout Engine
→ SAM2 lub odpowiednik

Nexus Quality Engine
→ Real-ESRGAN / FFmpeg

Nexus Render Controller
→ orkiestracja wszystkich etapów

Nie musisz ich teraz wdrażać w Cloud Builder.

ALE architektura assetów projektu powinna pozwalać później na:

USER:
„Wygeneruj film reklamowy produktu i dodaj go do strony głównej.”

Nexus:
1. tworzy render task,
2. AI Video Studio generuje plik,
3. wynik trafia do project assets,
4. Builder dodaje video do strony.

==================================================
20. ASSET MANAGER
==================================================

Dodaj koncepcję project assets.

Typy:

image
video
audio
logo
icon
document

Każdy asset:

id
project_id
type
filename
source
status
metadata

Builder powinien móc użyć assetu bez kopiowania go losowo po projekcie.

==================================================
21. STATUS SYSTEM
==================================================

Każde długie zadanie powinno posiadać status.

queued
planning
running
testing
reviewing
completed
failed

Plus:

current_step
progress
error_message

Użytkownik powinien wiedzieć:

co Nexus aktualnie robi.

==================================================
22. TOOL PERMISSIONS
==================================================

Nexus może automatycznie wykonywać lokalne, odwracalne operacje projektowe.

Ale działania zewnętrzne wymagające pieniędzy lub publikacji muszą być traktowane ostrożnie.

Przykłady wymagające zgody:

- zakup domeny,
- płatny deployment,
- zakup kredytów,
- uruchomienie płatnego API,
- płatny GPU,
- publikacja projektu, jeśli ma konsekwencje zewnętrzne.

==================================================
23. PIERWSZA WERSJA MVP
==================================================

NIE próbuj zrobić wszystkiego w jednym ogromnym patchu.

MVP:

PHASE 1

Project model
Project memory
Project workspace
Project selection

PHASE 2

Planner
Builder
Coder
Tester

PHASE 3

Live Preview
Snapshots
Rollback

PHASE 4

No-Code UI

PHASE 5

Assets
GitHub adapter

PHASE 6

Video Studio integration

==================================================
24. PIERWSZY PRAWDZIWY TEST
==================================================

Po zbudowaniu MVP wykonaj test:

USER PROMPT:

„Zbuduj nowoczesną stronę dla firmy AI o nazwie Nexus.
Ciemny wygląd.
Hero section.
Opis usług.
3 karty produktów.
Sekcja kontakt.
Responsywna wersja mobilna.”

System powinien:

1. utworzyć nowy projekt,
2. stworzyć plan,
3. utworzyć pliki,
4. uruchomić projekt,
5. wykonać typecheck/build,
6. pokazać preview,
7. zapisać snapshot.

Następnie test:

„Zmień kolor akcentu na zielony i dodaj sekcję FAQ.”

System powinien:

- zmienić istniejący projekt,
- NIE wygenerować całości od początku,
- wykonać test,
- utworzyć kolejny snapshot.

Następnie:

„Cofnij ostatnią zmianę.”

Rollback musi działać.

==================================================
25. INTERFEJS
==================================================

Docelowy ekran:

------------------------------------------------
| PROJECTS | NEXUS CHAT      | LIVE PREVIEW   |
|          |                 |                |
| project1 | User/Nexus      | running app    |
| project2 | conversation    |                |
|          |                 |                |
------------------------------------------------
| STATUS / TASKS / BUILD LOG                   |
------------------------------------------------

Na mobile interfejs może używać zakładek.

==================================================
26. NIE PRZEINŻYNIEROWUJ
==================================================

Najpierw działający pionowy slice:

PROMPT
→ PLAN
→ FILE EDIT
→ TEST
→ PREVIEW

Dopiero potem rozbudowa.

Nie buduj dziesiątek abstrakcji przed pierwszym działającym projektem.

==================================================
27. WYMAGANIA JAKOŚCIOWE
==================================================

Po każdym logicznym etapie:

- typecheck,
- odpowiednie testy,
- sprawdzenie logów,
- zapis wyników.

Jeżeli projekt zmienił się równolegle:
ponownie odczytaj aktualną wersję pliku przed zapisem.

Nie nadpisuj cudzych równoległych zmian.

==================================================
28. KOŃCOWY CEL
==================================================

Docelowo użytkownik ma móc powiedzieć:

„Nexus, stwórz mi aplikację rezerwacji wizyt.”

Nexus sam:

- tworzy projekt,
- planuje,
- projektuje UI,
- pisze kod,
- tworzy bazę,
- uruchamia,
- testuje,
- naprawia,
- pokazuje preview,
- pamięta projekt.

Potem użytkownik:

„Dodaj płatności.”

Nexus zmienia istniejącą aplikację.

Potem:

„Zrób film reklamowy z Luną i dodaj go na landing page.”

Nexus:

- deleguje film do AI Video Studio,
- odbiera gotowy asset,
- dodaje go do projektu,
- testuje stronę,
- pokazuje nową wersję.

Użytkownik nie musi pisać kodu.

To ma być:

NEXUS = AI OPERATING SYSTEM FOR BUILDING DIGITAL PRODUCTS.

==================================================
29. TERAZ
==================================================

Najpierw:

1. przeanalizuj aktualny nexus-ai,
2. sprawdź istniejące agent tools, agent memory, project/workspace capabilities i Floot native capabilities,
3. nie twórz duplikatów,
4. przedstaw krótki plan implementacji,
5. zacznij od PHASE 1,
6. po każdej fazie uruchom testy,
7. raportuj dokładnie:
   - co zostało dodane,
   - jakie pliki zmieniono,
   - jakie testy przeszły,
   - co jeszcze nie działa.

Nie deklaruj sukcesu na podstawie samego kodu.
Sukces wymaga działającego testu.


==================================================
30. FREE-FIRST PROVIDER FALLBACK
==================================================

Cel:
Nexus ma kontynuować pracę nawet wtedy, gdy bieżący dostawca AI przestanie odpowiadać albo wyczerpie bezpłatny limit/punkty.

Preferowana kolejność:

1. GitHub Copilot / Codex — używaj jako pierwszego dostawcy, jeśli jest dostępny i ma aktywny darmowy lub już opłacony limit użytkownika.
2. ChatGPT plan direct — chodzi o ChatGPT z aktualnego pakietu/subskrypcji użytkownika, tego samego konta używanego w ChatGPT, a NIE o płatne OpenAI API ani osobno kupowane kredyty. Używaj wyłącznie wtedy, gdy lokalny Agent Hub potwierdzi:
   connected=true
   planUsageEnabled=true
   Nie używaj płatnego OpenAI API jako automatycznego fallbacku.
3. Ollama local — darmowy fallback końcowy, bez kredytów za zapytania.

Jeśli ChatGPT plan direct nie jest dostępny albo planUsageEnabled=false:
Copilot/Codex → Ollama.

Jeśli Copilot/Codex zgłosi quota exhausted, rate limit, provider unavailable, credits exhausted lub odpowiednik błędu dostępności:
- zapisz bieżący stan zadania,
- NIE zaczynaj pracy od początku,
- przełącz provider na następny dostępny,
- kontynuuj z tym samym project context, memory, task state i workspace,
- odnotuj zmianę providera w statusie zadania.

Nie przełączaj automatycznie na płatne API, płatne kredyty ani nową subskrypcję.
Jakiekolwiek nowe płatne użycie wymaga wyraźnej zgody użytkownika.

Provider jest wymienny.
Planner, Builder, Coder, Tester i Reviewer nie mogą być trwale związani z jednym modelem.

Stan zadania musi być niezależny od providera:
- project_id
- task_id
- current_step
- completed_steps
- pending_steps
- files_changed
- tests_passed
- tests_failed
- last_error
- memory/context snapshot
- provider_used

Po zmianie providera agent ma najpierw odczytać stan i kontynuować od ostatniego bezpiecznego punktu.

Wymagany test:
1. rozpocznij zadanie na providerze A,
2. zasymuluj błąd quota/rate-limit,
3. przełącz na provider B,
4. potwierdź, że zadanie kontynuuje bez powtórzenia ukończonych kroków,
5. uruchom typecheck/testy,
6. zapisz wynik.

Nie deklaruj działania fallbacku, dopóki ten test nie przejdzie.
