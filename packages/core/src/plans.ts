// Plan limits live in code; clients.plan picks the row and clients.plan_overrides
// shallow-merges on top (admin escape hatch, no billing integration in this release).

import { PLANS, type Plan } from './domain/types';

export interface PlanLimits {
  socialAccounts: number;
  aiGenerationsPerMonth: number;
  aiReplySuggestionsPerMonth: number;
  autoReply: boolean;
  knowledgeSources: number;
  knowledgePages: number;
  contentFromBusiness: boolean;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  starter: {
    socialAccounts: 3,
    aiGenerationsPerMonth: 60,
    aiReplySuggestionsPerMonth: 100,
    autoReply: false,
    // Brand profile only.
    knowledgeSources: 0,
    knowledgePages: 0,
    contentFromBusiness: false,
  },
  pro: {
    socialAccounts: 10,
    aiGenerationsPerMonth: 600,
    aiReplySuggestionsPerMonth: 2000,
    autoReply: true,
    knowledgeSources: 10,
    knowledgePages: 200,
    contentFromBusiness: true,
  },
  agency: {
    socialAccounts: 50,
    aiGenerationsPerMonth: 3000,
    aiReplySuggestionsPerMonth: 10000,
    autoReply: true,
    knowledgeSources: 50,
    knowledgePages: 1000,
    contentFromBusiness: true,
  },
};

export const PLAN_LABELS: Record<Plan, string> = {
  starter: 'Starter',
  pro: 'Pro',
  agency: 'Agency',
};

const NUMERIC_KEYS = [
  'socialAccounts',
  'aiGenerationsPerMonth',
  'aiReplySuggestionsPerMonth',
  'knowledgeSources',
  'knowledgePages',
] as const satisfies readonly (keyof PlanLimits)[];

const BOOLEAN_KEYS = ['autoReply', 'contentFromBusiness'] as const satisfies readonly (keyof PlanLimits)[];

/** Plan defaults with `plan_overrides` applied. Unknown or ill-typed keys are ignored. */
export function resolvePlanLimits(plan: Plan, overrides?: Record<string, unknown> | null): PlanLimits {
  const limits: PlanLimits = { ...PLAN_LIMITS[plan] };
  if (!overrides) return limits;
  for (const key of NUMERIC_KEYS) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) limits[key] = Math.floor(value);
  }
  for (const key of BOOLEAN_KEYS) {
    const value = overrides[key];
    if (typeof value === 'boolean') limits[key] = value;
  }
  return limits;
}

export function planAllows(plan: Plan, feature: 'autoReply' | 'contentFromBusiness', overrides?: Record<string, unknown> | null): boolean {
  return resolvePlanLimits(plan, overrides)[feature];
}

export function planLimit(
  plan: Plan,
  key: (typeof NUMERIC_KEYS)[number],
  overrides?: Record<string, unknown> | null,
): number {
  return resolvePlanLimits(plan, overrides)[key];
}

export function isKnownPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value);
}
