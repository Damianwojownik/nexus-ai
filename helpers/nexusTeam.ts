import type { NexusAgent, NexusAgentResult } from './nexusAgent.ts';

export type NexusSpecialistId =
  | 'technical-seo'
  | 'keyword-research'
  | 'content-aeo'
  | 'analytics'
  | 'backlinks'
  | 'local-seo'
  | 'reviewer';

export interface NexusSpecialistProfile {
  id: NexusSpecialistId;
  name: string;
  capabilities: string[];
  phase: 1 | 2 | 3;
  rolePrompt: string;
}

export interface NexusSpecialistTask {
  id: string;
  agentId: string;
  title: string;
  goal: string;
  capabilities: string[];
  phase: 1 | 2 | 3;
  dependsOn: string[];
}

export interface NexusSpecialistReport {
  agentId: string;
  name: string;
  status: 'DONE' | 'FAILED';
  text: string;
  reasoning: string[];
  durationMs: number;
}

export interface NexusTeamEvent {
  agentId: string;
  name: string;
  status: 'STARTED' | 'DONE' | 'FAILED';
  message: string;
}

export interface NexusTeamResult {
  plan: NexusSpecialistTask[];
  reports: NexusSpecialistReport[];
  reviewer: NexusSpecialistReport;
  summary: string;
}

const profiles: NexusSpecialistProfile[] = [
  {
    id: 'technical-seo',
    name: 'Specjalista SEO technicznego',
    capabilities: ['crawler', 'indexation', 'robots', 'sitemap', 'http-status', 'metadata', 'canonicals', 'headings', 'internal-links', 'images', 'structured-data'],
    phase: 1,
    rolePrompt: 'Jesteś niezależnym ekspertem Technical SEO. Gdy użytkownik poda publiczny URL, użyj technical_seo_audit. Przy prośbie o szybkość uruchom również pagespeed_audit (mobile; desktop tylko gdy ma sens). Raportuj wyłącznie wyniki rzeczywiście zwrócone przez narzędzia. Rozdziel problemy krytyczne, wysokie, średnie i niskie. Nie zgaduj danych Search Console, backlinków ani ruchu. Wyjaśnij ograniczenie crawla i zaproponuj kolejność napraw.',
  },
  {
    id: 'keyword-research',
    name: 'Specjalista słów kluczowych i konkurencji',
    capabilities: ['keyword-intent', 'serp-research', 'competitors', 'keyword-clusters', 'topic-gaps', 'content-plan'],
    phase: 1,
    rolePrompt: 'Jesteś ekspertem researchu słów kluczowych i konkurencji organicznej. Używaj web_search dla aktualnych, publicznie dostępnych wyników i oznaczaj URL źródła. Twórz klastry według intencji (informacyjna, komercyjna, transakcyjna, nawigacyjna), mapuj frazy na typy stron i wskazuj luki tematyczne. Nie wymyślaj wolumenów, CPC, KD ani pozycji. Jeśli nie ma danych Semrush/keyword volume, nazwij je hipotezami wymagającymi walidacji.',
  },
  {
    id: 'content-aeo',
    name: 'Specjalista Content SEO i AEO',
    capabilities: ['content-quality', 'topical-authority', 'faq', 'schema', 'direct-answers', 'ai-readability', 'entity-coverage'],
    phase: 2,
    rolePrompt: 'Jesteś ekspertem Content SEO, AEO i czytelności dla wyszukiwarek oraz systemów odpowiedzi AI. Wykorzystaj raport Technical SEO i keyword research przekazany w kontekście. Oceń pokrycie intencji, strukturę nagłówków, odpowiedzi bezpośrednie, FAQ, wiarygodność, aktualność, encje, linkowanie i schema. Odróżniaj sygnały on-page od rzeczywistej widoczności w AI, której nie da się potwierdzić samą treścią strony. Zaproponuj konkretny plan treści i przykładowe sekcje.',
  },
  {
    id: 'analytics',
    name: 'Specjalista Search Console i GA4',
    capabilities: ['search-console', 'ga4', 'clicks', 'impressions', 'ctr', 'positions', 'traffic', 'conversions'],
    phase: 1,
    rolePrompt: 'Jesteś analitykiem organic search. Najpierw użyj seo_integrations_status. Jeśli Search Console lub GA4 są skonfigurowane, pobierz odpowiedni raport read-only. W przeciwnym razie jasno wypisz, że dane są niedostępne do czasu autoryzacji Google OAuth. Rozdziel kliknięcia i wyświetlenia GSC od sesji i konwersji GA4. Nie twórz fikcyjnych metryk ani wniosków o ruchu.',
  },
  {
    id: 'backlinks',
    name: 'Specjalista link building i autorytetu',
    capabilities: ['backlinks', 'referring-domains', 'anchors', 'link-quality', 'authority', 'competitor-links'],
    phase: 1,
    rolePrompt: 'Jesteś specjalistą analizy profilu linków. Najpierw sprawdź seo_integrations_status. Nie wykonuj płatnych zapytań do API Semrush ani innego płatnego dostawcy bez odrębnej, jawnej zgody użytkownika. Gdy dostawca nie jest podłączony, wypisz brakujące dane i poproś o autoryzację/akceptację kosztów. Nie szacuj liczby backlinków na podstawie zwykłego crawla.',
  },
  {
    id: 'local-seo',
    name: 'Specjalista Local SEO',
    capabilities: ['google-business-profile', 'local-schema', 'nap', 'reviews', 'local-landing-pages', 'maps-visibility'],
    phase: 1,
    rolePrompt: 'Jesteś ekspertem Local SEO. Użyj seo_integrations_status i, jeśli istnieje raport crawla, sprawdź sygnały LocalBusiness/Organization, adres, telefon, godziny, lokalne landing pages i dane NAP. Nie twierdź, że sprawdziłeś Google Business Profile, opinie ani Mapy, jeśli integracja nie jest skonfigurowana. Nie twórz fikcyjnych ocen ani danych wizytówki.',
  },
  {
    id: 'reviewer',
    name: 'Niezależny recenzent',
    capabilities: ['cross-review', 'evidence-check', 'contradictions', 'prioritization', 'quality-control'],
    phase: 3,
    rolePrompt: 'Jesteś niezależnym recenzentem pracy zespołu SEO. Nie używaj narzędzi i nie wykonuj nowego audytu. Oceniaj tylko przekazane raporty. Odrzuć wnioski bez dowodów, wskaż sprzeczności, oddziel dane od hipotez, sprawdź, czy nie obiecano pozycji lub widoczności AI. Zwróć końcowy, priorytetyzowany plan: krytyczne naprawy, działania 30 dni, działania 60–90 dni, metryki do monitorowania oraz brakujące integracje.',
  },
];

function isSeoIntent(text: string): boolean {
  return /\b(seo|aeo|pozycjon|search engine|audyt strony|audyt witryny|widoczno.{0,12}google)\b/i.test(text);
}

export function buildSeoTeamPlan(text: string): NexusSpecialistTask[] {
  if (!isSeoIntent(text)) return [];
  const selected = profiles;
  return selected.map((profile) => ({
    id: profile.id,
    agentId: 'nexus-' + profile.id,
    title: profile.name,
    goal: profile.id === 'reviewer'
      ? 'Niezależnie zweryfikuj raporty specjalistów, dowody, ograniczenia i priorytety.'
      : 'Wykonaj specjalistyczną analizę SEO/AEO zgodnie ze swoimi kompetencjami.',
    capabilities: [...profile.capabilities],
    phase: profile.phase,
    dependsOn: profile.phase === 2 ? ['technical-seo', 'keyword-research'] : profile.phase === 3 ? profiles.filter((item) => item.phase !== 3).map((item) => item.id) : [],
  }));
}

function truncate(value: string, limit = 6500): string {
  return value.length > limit ? value.slice(0, limit) + '\n[raport skrócony]' : value;
}

export class NexusTeamOrchestrator {
  private readonly agent: NexusAgent;

  constructor(agent: NexusAgent) {
    this.agent = agent;
  }

  async run(
    input: { text: string; history?: Array<{ role: 'user' | 'assistant'; content: string }>; projectContext?: string },
    onEvent: (event: NexusTeamEvent) => void | Promise<void> = () => undefined,
  ): Promise<NexusTeamResult> {
    const plan = buildSeoTeamPlan(input.text);
    if (!plan.length) throw new Error('No specialist team is registered for this task.');

    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    const reportById = new Map<string, NexusSpecialistReport>();
    const phaseOne = plan.filter((task) => task.phase === 1);

    const execute = async (task: NexusSpecialistTask, dependencies: string): Promise<NexusSpecialistReport> => {
      const profile = profileById.get(task.id as NexusSpecialistId)!;
      const startedAt = Date.now();
      await onEvent({ agentId: task.agentId, name: profile.name, status: 'STARTED', message: profile.name + ' rozpoczyna pracę.' });
      try {
        const result: NexusAgentResult = await this.agent.send({
          text: input.text,
          mode: 'AUTO',
          history: input.history,
          projectContext: [input.projectContext, dependencies].filter(Boolean).join('\n\n'),
          agentRolePrompt: profile.rolePrompt,
          disabledTools: task.id === 'reviewer'
            ? ['web_search', 'get_weather', 'technical_seo_audit', 'pagespeed_audit', 'seo_integrations_status', 'search_console_report', 'ga4_report']
            : [],
          maxOutputTokens: task.id === 'reviewer' ? 1700 : 1300,
        });
        const report: NexusSpecialistReport = {
          agentId: task.agentId,
          name: profile.name,
          status: 'DONE',
          text: truncate(result.text),
          reasoning: result.reasoning,
          durationMs: Date.now() - startedAt,
        };
        reportById.set(task.id, report);
        await onEvent({ agentId: task.agentId, name: profile.name, status: 'DONE', message: profile.name + ' zakończył analizę.' });
        return report;
      } catch (error) {
        const report: NexusSpecialistReport = {
          agentId: task.agentId,
          name: profile.name,
          status: 'FAILED',
          text: error instanceof Error ? error.message : String(error),
          reasoning: [],
          durationMs: Date.now() - startedAt,
        };
        reportById.set(task.id, report);
        await onEvent({ agentId: task.agentId, name: profile.name, status: 'FAILED', message: profile.name + ' nie zakończył pracy: ' + report.text });
        return report;
      }
    };

    await Promise.all(phaseOne.map((task) => execute(task, '')));
    const phaseTwo = plan.filter((task) => task.phase === 2);
    const phaseTwoContext = phaseOne
      .map((task) => {
        const report = reportById.get(task.id);
        return report ? '### ' + report.name + ' [' + report.status + ']\n' + report.text : '';
      })
      .filter(Boolean)
      .join('\n\n');
    await Promise.all(phaseTwo.map((task) => execute(task, phaseTwoContext)));

    const reviewer = plan.find((task) => task.id === 'reviewer')!;
    const reviewContext = plan
      .filter((task) => task.id !== 'reviewer')
      .map((task) => {
        const report = reportById.get(task.id);
        return report ? '### ' + report.name + ' [' + report.status + ']\n' + report.text : '';
      })
      .filter(Boolean)
      .join('\n\n');

    const reviewerReport = await execute(reviewer, 'Raporty do niezależnej recenzji:\n' + reviewContext);
    const reports = plan.filter((task) => task.id !== 'reviewer').map((task) => reportById.get(task.id)!).filter(Boolean);
    const summary = [
      '# Zespół Nexus SEO/AEO',
      '',
      'Wykonane role: ' + reports.filter((report) => report.status === 'DONE').length + '/' + reports.length + '. Recenzent: ' + reviewerReport.status + '.',
      '',
      ...reports.map((report) => '## ' + report.name + ' — ' + report.status + '\n' + report.text),
      '',
      '## Niezależna kontrola jakości',
      reviewerReport.text,
    ].join('\n');

    return { plan, reports, reviewer: reviewerReport, summary };
  }
}
