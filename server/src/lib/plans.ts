export type PlanId = 'free' | 'pro' | 'team';

export interface PlanLimits {
  id: PlanId;
  name: string;
  priceLabel: string;
  maxProjects: number;
  runsPerMonth: number;
  maxMembers: number;
  viewports: string[];
  maxPages: number;
  repoAnalysis: boolean;
  historyDays: number;
  emailNotifications: boolean;
  features: string[];
}

// Prices are illustrative; billing runs in test mode (no payment processor is charged).
export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: 'free',
    name: 'Free',
    priceLabel: '$0',
    maxProjects: 1,
    runsPerMonth: 25,
    maxMembers: 1,
    viewports: ['desktop', 'mobile'],
    maxPages: 6,
    repoAnalysis: false,
    historyDays: 14,
    emailNotifications: false,
    features: ['1 project', '25 QA runs / month', 'Functional + API + visual QA (desktop & mobile)', 'Basic reports', '14-day history'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceLabel: '$29 / mo',
    maxProjects: 10,
    runsPerMonth: 300,
    maxMembers: 1,
    viewports: ['desktop', 'tablet', 'mobile'],
    maxPages: 15,
    repoAnalysis: true,
    historyDays: 90,
    emailNotifications: true,
    features: ['10 projects', '300 QA runs / month', 'Tablet viewport + visual baselines', 'Repository root-cause analysis', 'Email alerts', '90-day history'],
  },
  team: {
    id: 'team',
    name: 'Team',
    priceLabel: '$99 / mo',
    maxProjects: 50,
    runsPerMonth: 1500,
    maxMembers: 10,
    viewports: ['desktop', 'tablet', 'mobile'],
    maxPages: 25,
    repoAnalysis: true,
    historyDays: 365,
    emailNotifications: true,
    features: ['Up to 10 developers', 'Shared workspace & roles', '1,500 QA runs / month', 'Advanced reporting', '1-year history', 'CI/CD triggers (coming soon)'],
  },
};

export const VIEWPORTS: Record<string, { name: string; width: number; height: number; isMobile: boolean }> = {
  desktop: { name: 'desktop', width: 1440, height: 900, isMobile: false },
  tablet: { name: 'tablet', width: 768, height: 1024, isMobile: true },
  mobile: { name: 'mobile', width: 375, height: 812, isMobile: true },
};

export function planFor(id: string | undefined | null): PlanLimits {
  return PLANS[(id as PlanId) || 'free'] || PLANS.free;
}
