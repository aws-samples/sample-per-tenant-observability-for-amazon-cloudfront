import { DEFAULT_STACK_NAME, parseContext } from '../lib/context';

const parse = (values: Record<string, unknown>) => parseContext((key) => values[key]);
const demo = { hostedZoneId: 'Z1', hostedZoneName: 'example.com' };

describe('parseContext', () => {
  test('demo defaults', () => {
    const { stackName, props } = parse(demo);
    expect(stackName).toBe(DEFAULT_STACK_NAME);
    expect(props.demo).toEqual({ hostedZoneId: 'Z1', hostedZoneName: 'example.com', tenantSubdomain: undefined });
    expect(props.distributionId).toBeUndefined();
    expect(props.nearRealTime).toBeUndefined();
  });

  test('existing distribution with tenants, flags, and numbers', () => {
    const { stackName, props } = parse({
      distributionId: 'E1', stackName: 'tenants-shop', tenants: 'shop-one=dt_1, shop-two=dt_2',
      alarmedTenants: 'shop-two', nearRealTime: 'true', deleteLogsOnDestroy: 'false',
      logRetentionDays: '120', errorRateThreshold: '10', alarmMinRequests: '50', rankingRules: 'requests,bytes',
    });
    expect(stackName).toBe('tenants-shop');
    expect(props.demo).toBeUndefined();
    expect(props.tenants).toEqual([{ name: 'shop-one', id: 'dt_1' }, { name: 'shop-two', id: 'dt_2' }]);
    expect(props).toMatchObject({
      alarmedTenantNames: ['shop-two'], nearRealTime: true, deleteLogsOnDestroy: false,
      logRetentionDays: 120, errorRateThreshold: 10, alarmMinRequests: 50, rankingRules: ['requests', 'bytes'],
    });
  });

  test('accepts non-string values set in cdk.json', () => {
    const { props } = parse({ ...demo, nearRealTime: false, logRetentionDays: 90 });
    expect(props.nearRealTime).toBe(false);
    expect(props.logRetentionDays).toBe(90);
  });

  test('errorRateThreshold accepts decimals', () => {
    expect(parse({ ...demo, errorRateThreshold: '0.5' }).props.errorRateThreshold).toBe(0.5);
  });

  test('noLogsAlarmMinutes accepts 0 to turn the alarm off', () => {
    expect(parse({ distributionId: 'E1', noLogsAlarmMinutes: '0' }).props.noLogsAlarmMinutes).toBe(0);
  });

  test('alarmedTenants=none turns off the default demo alarm', () => {
    expect(parse({ ...demo, alarmedTenants: 'none' }).props.alarmedTenantNames).toEqual([]);
  });

  test.each([
    [{ distributionId: 'E1', hostedZoneId: 'Z1' }, /are for the demo/],
    [{ distributionId: 'E1', tenantSubdomain: 'x' }, /are for the demo/],
    [{ ...demo, tenants: 'a=dt_1' }, /tenants is for an existing distribution/],
    [{}, /distributionId/],
    [{ ...demo, nearRealTime: 'no' }, /"nearRealTime" must be true or false/],
    [{ ...demo, logRetentionDays: 'abc' }, /"logRetentionDays" must be a whole number/],
    [{ ...demo, logRetentionDays: '0' }, /"logRetentionDays" must be a whole number/],
    [{ ...demo, errorRateThreshold: '100' }, /"errorRateThreshold" must be a number greater than 0 and less than 100/],
    [{ ...demo, errorRateThreshold: '0' }, /"errorRateThreshold" must be a number greater than 0/],
    [{ ...demo, rankingRules: 'requests,latency' }, /Unknown rankingRules: latency/],
    [{ ...demo, noLogsAlarmMinutes: '1441' }, /"noLogsAlarmMinutes" must be a whole number from 0 to 1440/],
    [{ ...demo, noLogsAlarmMinutes: '-1' }, /"noLogsAlarmMinutes" must be a whole number/],
    [{ distributionId: 'E1', tenants: 'shop-one' }, /Invalid tenants entry "shop-one"/],
    [{ distributionId: 'E1', tenants: 'a=b=c' }, /Invalid tenants entry "a=b=c"/],
    [{ ...demo, stackName: '1bad' }, /"stackName" must start with a letter/],
    [{ ...demo, stackName: 'a'.repeat(41) }, /at most 40 characters/],
  ])('rejects invalid context %#', (values, message) => {
    expect(() => parse(values)).toThrow(message);
  });
});
