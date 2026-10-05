import type { IdentityProfile, IdentityReference } from './types.ts';

export type IdentityLockStatus = {
  ok: boolean;
  profileId: string;
  referenceCount: number;
  coverage: number;
  warnings: string[];
};

const REQUIRED_VIEWS: IdentityReference['view'][] = [
  'front',
  'three-quarter-left',
  'three-quarter-right',
];

export class IdentityLock {
  private readonly profile: IdentityProfile;

  constructor(profile: IdentityProfile) {
    this.profile = profile;
  }

  getProfile(): IdentityProfile {
    return {
      ...this.profile,
      references: this.profile.references.map(r => ({ ...r })),
    };
  }

  validate(): IdentityLockStatus {
    const warnings:string[]=[];
    const views=new Set(this.profile.references.map(r=>r.view));
    const covered=REQUIRED_VIEWS.filter(v=>views.has(v)).length;

    if (!views.has('front')) warnings.push('Missing front reference');
    if (!views.has('three-quarter-left')) warnings.push('Missing three-quarter-left reference');
    if (!views.has('three-quarter-right')) warnings.push('Missing three-quarter-right reference');
    if (this.profile.references.length < 3) warnings.push('Use at least three consistent references for identity locking');
    if (new Set(this.profile.references.map(r=>r.uri)).size !== this.profile.references.length) {
      warnings.push('Duplicate reference URI');
    }

    return {
      ok: warnings.length === 0,
      profileId: this.profile.id,
      referenceCount: this.profile.references.length,
      coverage: covered / REQUIRED_VIEWS.length,
      warnings,
    };
  }

  /**
   * Renderer-facing reference set. The actual neural embedding/adapter can be
   * swapped later; this keeps identity ownership inside Miś Engine.
   */
  rendererReferences():Array<IdentityReference & { weight:number }> {
    return this.profile.references
      .map(r=>({...r,weight:Math.max(0,Math.min(1,r.weight ?? (r.view === 'front' ? 1 : .8)))}))
      .sort((a,b)=>b.weight-a.weight);
  }
}
