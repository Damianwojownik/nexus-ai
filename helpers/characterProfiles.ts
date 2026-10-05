import type { CharacterIdentity } from './characterEngine.ts';

export interface CharacterProfile {
  identity: CharacterIdentity;
  name: string;
  portrait: string;
  renderingStatus: 'reference-only';
  expressionReferences?: Readonly<{
    blink: string;
    glance: string;
  }>;
  expressionReferenceSha256?: Readonly<{
    blink: string;
    glance: string;
  }>;
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
  {
    identity: {
      id: 'nexus-librarian', revision: '1', rigRevision: 'neural-stream-v1',
      referenceSha256: '5810f3518ad5ac9a326ae720797c9c9117fb8160f94f00caeec019a260ea2e04',
    },
    name: 'Nexus — bibliotekarka',
    portrait: '/avatars/references/nexus-librarian/nexus-librarian-front-facing.jpeg',
    renderingStatus: 'reference-only',
    expressionReferences: {
      blink: '/avatars/references/nexus-librarian/nexus-librarian-eyes-closed.jpeg',
      glance: '/avatars/references/nexus-librarian/nexus-librarian-reading-left.jpeg',
    },
    expressionReferenceSha256: {
      blink: 'f59341b3d82d458dccc5c655e9315e1cb39edf6d5d2b937408632a14ae604de9',
      glance: '8615dbd338dc3ff61fca9efc8501f179f8a3cacde42a0faabb0e5a9544b26fa8',
    },
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
