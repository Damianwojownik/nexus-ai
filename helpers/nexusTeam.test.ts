import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSeoTeamPlan, NexusTeamOrchestrator } from './nexusTeam.ts';
import type { NexusAgent } from './nexusAgent.ts';

test('SEO team plan declares specialist skills, independent parallel work and review dependencies', () => {
  assert.deepEqual(buildSeoTeamPlan('Pomóż mi przygotować plan marketingowy.'), []);
  const plan = buildSeoTeamPlan('Zrób kompleksowy audyt SEO i AEO strony.');
  assert.equal(plan.length, 7);
  assert.deepEqual(plan.filter((task) => task.phase === 1).map((task) => task.id), [
    'technical-seo', 'keyword-research', 'analytics', 'backlinks', 'local-seo',
  ]);
  assert.deepEqual(plan.find((task) => task.id === 'content-aeo')?.dependsOn, ['technical-seo', 'keyword-research']);
  assert.equal(plan.find((task) => task.id === 'reviewer')?.phase, 3);
  assert.equal(plan.find((task) => task.id === 'reviewer')?.dependsOn.length, 6);
});

test('specialists execute in dependency-aware phases and the reviewer runs last without tools', async () => {
  const calls: Array<{ role?: string; projectContext?: string; disabledTools?: string[] }> = [];
  const agent = {
    async send(input: any) {
      calls.push({
        role: input.agentRolePrompt,
        projectContext: input.projectContext,
        disabledTools: input.disabledTools,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { text: 'verified report: ' + input.agentRolePrompt.slice(0, 40), reasoning: [], mode: 'AUTO' };
    },
  } as unknown as NexusAgent;

  const events: string[] = [];
  const team = new NexusTeamOrchestrator(agent);
  const result = await team.run(
    { text: 'Przeprowadź kompleksowy audyt SEO i AEO https://example.com' },
    (event) => { events.push(event.agentId + ':' + event.status); },
  );

  assert.equal(result.plan.length, 7);
  assert.equal(result.reports.length, 6);
  assert.equal(result.reviewer.status, 'DONE');
  assert.match(result.summary, /Niezależna kontrola jakości/);
  assert.equal(calls.length, 7);

  const reviewerCall = calls[calls.length - 1];
  assert.match(reviewerCall.role ?? '', /niezależnym recenzentem/i);
  assert.match(reviewerCall.projectContext ?? '', /Specjalista SEO technicznego/);
  assert.deepEqual(reviewerCall.disabledTools, [
    'web_search', 'get_weather', 'technical_seo_audit', 'pagespeed_audit',
    'seo_integrations_status', 'search_console_report', 'ga4_report',
  ]);

  const phaseOneFinished = events.findIndex((event) => event.endsWith(':DONE') && event.startsWith('nexus-keyword-research'));
  const contentStarted = events.findIndex((event) => event.startsWith('nexus-content-aeo:STARTED'));
  assert.ok(phaseOneFinished >= 0);
  assert.ok(contentStarted > phaseOneFinished);
});
