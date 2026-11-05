import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { PerTenantObservabilityStack, PerTenantObservabilityStackProps } from '../lib/per-tenant-observability-stack';

const env = { account: '111111111111', region: 'us-east-1' };
const demo = { hostedZoneId: 'Z0000000000000', hostedZoneName: 'example.com' };

// Same plugin setup as bin/: synth fails if any AwsSolutions finding isn't acknowledged.
const synthWithNag = (props: Omit<PerTenantObservabilityStackProps, 'env'>) => {
  const app = new cdk.App();
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  new PerTenantObservabilityStack(app, 'NagStack', { env, ...props });
  return () => app.synth();
};

describe('cdk-nag AwsSolutionsChecks', () => {
  test.each([
    ['demo with alarm email', { demo, alarmEmail: 'ops@example.com', noLogsAlarmMinutes: 15 }],
    ['reports only', { demo, nearRealTime: false }],
    ['existing distribution', {
      distributionId: 'E1234567890ABC', tenants: [{ name: 'a', id: 'dt_1' }], alarmedTenantNames: ['a'], alarmEmail: 'ops@example.com',
    }],
  ])('%s passes with every accepted finding acknowledged', (_name, props) => {
    expect(synthWithNag(props)).not.toThrow();
  });
});
