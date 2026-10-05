import type { CharacterIdentity } from './characterEngine.ts';

export interface CharacterProfile {
  identity: CharacterIdentity;
  name: string;
  portrait: string;
  renderingStatus: 'reference-only';
}

export const CHARACTER_PROFILES: readonly CharacterProfile[] = [
  {
    identity: {
      id: 'luna', revision: '1', rigRevision: 'reference-only',
      referenceSha256: '9d9ded4b43bd9ae13001f4a0424ef9a73c58b7050d7a294be2bd5f38afc0f6ee',
    },
    name: 'Luna', portrait: '/avatars/nexus-android.png', renderingStatus: 'reference-only',
  },
  {
    identity: {
      id: 'bear', revision: '1', rigRevision: 'reference-only',
      referenceSha256: 'e5eef55b4c1e5e000e98a7276dff4fa1d73241351f45085e335351147cbfe51e',
    },
    name: 'Miś — oryginalny portret', portrait: '/avatars/bear-original.png', renderingStatus: 'reference-only',
  },
];

export function characterProfile(id: string): CharacterProfile {
  const profile = CHARACTER_PROFILES.find(item => item.identity.id === id);
  if (!profile) throw new Error(`Unknown character profile: ${id}`);
  return profile;
}

export async function verifiedCharacterPortrait(id: string, fetcher: typeof fetch = fetch): Promise<Blob> {
  const profile = characterProfile(id);
  const response = await fetcher(profile.portrait, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw new Error(`Character portrait HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.size || blob.size > 5 * 1024 * 1024) throw new Error('Character portrait must contain 1 byte to 5 MB');
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== profile.identity.referenceSha256) throw new Error('Character reference hash mismatch; no render job was prepared');
  return blob;
}
