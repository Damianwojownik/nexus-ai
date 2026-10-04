import React, { useEffect, useState } from 'react';
import { Button } from './Button';
import { Input } from './Input';
import { COMPANY_PROFILE_KEY, COMPANY_ROLES, createCompanyProfile, parseCompanyProfile } from '../helpers/companyWorkspace';
import type { CompanyDraft, CompanyProfile } from '../helpers/companyWorkspace';
import styles from '../pages/_index.module.css';

const emptyDraft: CompanyDraft = { name: '', description: '', website: '', goals: '', market: '' };

export function CompanyWorkspace({ profile, disabled, onChange }: {
  profile: CompanyProfile | null;
  disabled: boolean;
  onChange: (profile: CompanyProfile | null) => void;
}) {
  const [draft, setDraft] = useState<CompanyDraft>(emptyDraft);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(COMPANY_PROFILE_KEY);
      if (raw) {
        const saved = parseCompanyProfile(JSON.parse(raw));
        setDraft(saved);
        onChange(saved);
      }
    } catch (cause) {
      console.error('Company profile load failed:', cause);
      setError('Nie mozna wczytac profilu firmy. Popraw dane i zapisz nowy profil albo usun zapis.');
    } finally {
      setLoaded(true);
    }
  }, [onChange]);

  const field = (key: keyof CompanyDraft, value: string) => setDraft(current => ({ ...current, [key]: value }));
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled || !loaded) return;
    try {
      const next = createCompanyProfile(draft);
      localStorage.setItem(COMPANY_PROFILE_KEY, JSON.stringify(next));
      onChange(next);
      setDraft(next);
      setError('');
    } catch (cause) {
      console.error('Company profile save failed:', cause);
      setError(cause instanceof Error ? cause.message : 'Nie mozna zapisac profilu firmy.');
    }
  };
  const reset = () => {
    if (disabled || !loaded) return;
    try {
      localStorage.removeItem(COMPANY_PROFILE_KEY);
      onChange(null);
      setDraft(emptyDraft);
      setError('');
    } catch (cause) {
      console.error('Company profile reset failed:', cause);
      setError('Nie mozna usunac zapisu profilu firmy.');
    }
  };

  return <details className={styles.batchPanel}>
    <summary>Firma i cele — {profile?.name ?? 'skonfiguruj niezaleznego Nexusa'}</summary>
    <p>Podaj firme, adres strony i cel. Kazdy zapis tworzy nowa, pusta pamiec firmy bez historii Ezostylii. Profil jest zapisany tylko w tej przegladarce, nie w chmurze.</p>
    <form onSubmit={save}>
      <fieldset disabled={disabled || !loaded}>
        <label htmlFor="company-name">Jaka masz firme?</label>
        <Input id="company-name" value={draft.name} maxLength={160} required onChange={event => field('name', event.target.value)}/>
        <label htmlFor="company-description">Czym sie zajmuje i dla kogo?</label>
        <textarea id="company-description" value={draft.description} maxLength={2000} required rows={3} onChange={event => field('description', event.target.value)}/>
        <label htmlFor="company-website">Strona internetowa</label>
        <Input id="company-website" value={draft.website} maxLength={2048} required placeholder="https://twoja-firma.pl" onChange={event => field('website', event.target.value)}/>
        <label htmlFor="company-goals">Czego szukasz? Jaki jest cel?</label>
        <textarea id="company-goals" value={draft.goals} maxLength={1000} required rows={3} onChange={event => field('goals', event.target.value)}/>
        <label htmlFor="company-market">Rynek i jezyk klientow</label>
        <Input id="company-market" value={draft.market} maxLength={160} required placeholder="np. Polska, jezyk polski" onChange={event => field('market', event.target.value)}/>
        <div className={styles.portraitActions}>
          <Button type="submit">Zapisz firme i rozpocznij od zera</Button>
          <Button type="button" variant="secondary" onClick={reset}>Usun profil / tryb ogolny</Button>
        </div>
      </fieldset>
    </form>
    {error && <p role="alert">{error}</p>}
    {profile && <>
      <h3>Planowana hierarchia pracy</h3>
      <p>Wlasciciel → Nexus → SEO / Content / Growth → QA → Twoja zgoda.</p>
      <ul>{COMPANY_ROLES.map(role => <li key={role.id}><strong>{role.name}</strong>: {role.task}</li>)}</ul>
    </>}
    <p>Podanie adresu nie uruchamia audytu ani publikacji. To profil rozmowy z awatarem; skopiowany Growth Engine nie jest jeszcze uruchomiony. Nie wpisuj tutaj kluczy API ani hasel.</p>
  </details>;
}
