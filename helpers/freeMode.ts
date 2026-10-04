export function nexusFreeMode(value = process.env.NEXUS_FREE_MODE): boolean {
  if (value === undefined || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('NEXUS_FREE_MODE must be true or false');
}

export interface ProviderPricing {
  cost?: number;
  costClass: 'free-local' | 'free' | 'included' | 'paid';
  isLocal: boolean;
  requiresCredits?: boolean;
  requiresSubscription?: boolean;
}

export function freeProviderBlock(provider: ProviderPricing): string | undefined {
  if (provider.cost !== undefined && (!Number.isFinite(provider.cost) || provider.cost < 0)) return 'Invalid provider cost';
  if (provider.cost !== undefined && provider.cost > 0) return 'Provider cost is greater than zero';
  if (provider.requiresCredits || provider.requiresSubscription) return 'Provider requires credits or subscription';
  if (provider.costClass === 'paid' || provider.costClass === 'included') return 'Paid/subscription provider blocked';
  if (provider.costClass === 'free-local' && provider.isLocal && (provider.cost === undefined || provider.cost === 0)) return undefined;
  if (provider.costClass === 'free' && provider.cost === 0) return undefined;
  return 'Free pricing has not been verified';
}
