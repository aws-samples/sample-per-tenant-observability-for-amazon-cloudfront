import type { DemoOptions, PerTenantObservabilityStackProps } from './per-tenant-observability-stack';
import { RANKING_RULES, type RankingRule, type TenantRef } from './tenant-observability';

export const DEFAULT_STACK_NAME = 'PerTenantObservabilityStack';
/** Keeps derived resource names (for example the log delivery source, max 60 characters) within limits. */
export const MAX_STACK_NAME_LENGTH = 40;

export interface ParsedContext {
  readonly stackName: string;
  readonly props: Omit<PerTenantObservabilityStackProps, 'env'>;
}

/**
 * Reads and validates the -c context values passed to `cdk deploy`.
 * Throws an error that names the context key when a value is invalid.
 */
export function parseContext(get: (key: string) => unknown): ParsedContext {
  const text = (key: string): string | undefined => {
    const value = get(key);
    return value === undefined || value === null || value === '' ? undefined : String(value);
  };
  const flag = (key: string): boolean | undefined => {
    const value = text(key);
    if (value === undefined) return undefined;
    if (value === 'true' || value === 'false') return value === 'true';
    throw new Error(`Context value "${key}" must be true or false, got "${value}".`);
  };
  const integer = (key: string, min: number, max?: number): number | undefined => {
    const value = text(key);
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
      throw new Error(`Context value "${key}" must be a whole number from ${min}${max !== undefined ? ` to ${max}` : ''}, got "${value}".`);
    }
    return n;
  };
  const percent = (key: string): number | undefined => {
    const value = text(key);
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n >= 100) {
      throw new Error(`Context value "${key}" must be a number greater than 0 and less than 100, got "${value}".`);
    }
    return n;
  };
  const list = (key: string): string[] | undefined =>
    text(key)?.split(',').map((item) => item.trim()).filter(Boolean);

  const stackName = text('stackName') ?? DEFAULT_STACK_NAME;
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(stackName) || stackName.length > MAX_STACK_NAME_LENGTH) {
    throw new Error(`Context value "stackName" must start with a letter, use only letters, numbers, and hyphens, and be at most ${MAX_STACK_NAME_LENGTH} characters.`);
  }

  // -c tenants=name=dt_id,name=dt_id (existing distribution only; see scripts/list-tenants.mjs)
  const tenants: TenantRef[] | undefined = list('tenants')?.map((pair) => {
    const parts = pair.split('=');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid tenants entry "${pair}". Use name=tenantId, separated by commas.`);
    }
    return { name: parts[0].trim(), id: parts[1].trim() };
  });

  const rankingRules = list('rankingRules') as RankingRule[] | undefined;
  const invalid = rankingRules?.filter((rule) => !RANKING_RULES.includes(rule));
  if (invalid?.length) throw new Error(`Unknown rankingRules: ${invalid.join(', ')}. Use: ${RANKING_RULES.join(', ')}.`);

  const distributionId = text('distributionId');
  const hostedZoneId = text('hostedZoneId');
  const hostedZoneName = text('hostedZoneName');
  if (!distributionId && !(hostedZoneId && hostedZoneName)) {
    throw new Error('Pass -c distributionId=... for an existing distribution, or -c hostedZoneId=... -c hostedZoneName=... for the demo.');
  }
  if (distributionId && (hostedZoneId || hostedZoneName || text('tenantSubdomain'))) {
    throw new Error('hostedZoneId, hostedZoneName, and tenantSubdomain are for the demo. Remove them when you pass distributionId.');
  }
  if (!distributionId && tenants) {
    throw new Error('tenants is for an existing distribution. The demo creates its own tenants.');
  }
  // "none" turns off the demo's default tenant alarm.
  const alarmedTenants = text('alarmedTenants') === 'none' ? [] : list('alarmedTenants');

  const demo: DemoOptions | undefined = distributionId
    ? undefined
    : { hostedZoneId: hostedZoneId!, hostedZoneName: hostedZoneName!, tenantSubdomain: text('tenantSubdomain') };

  return {
    stackName,
    props: {
      distributionId,
      tenants,
      demo,
      nearRealTime: flag('nearRealTime'),
      deleteLogsOnDestroy: flag('deleteLogsOnDestroy'),
      logRetentionDays: integer('logRetentionDays', 1, 3650),
      rankingRules,
      alarmedTenantNames: alarmedTenants,
      errorRateThreshold: percent('errorRateThreshold'),
      alarmMinRequests: integer('alarmMinRequests', 1),
      alarmEmail: text('alarmEmail'),
      noLogsAlarmMinutes: integer('noLogsAlarmMinutes', 0, 1440),
    },
  };
}
