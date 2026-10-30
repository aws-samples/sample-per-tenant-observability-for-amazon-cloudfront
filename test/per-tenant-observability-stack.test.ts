import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { PerTenantObservabilityStack, PerTenantObservabilityStackProps } from '../lib/per-tenant-observability-stack';

const env = { account: '111111111111', region: 'us-east-1' };
const demo = { hostedZoneId: 'Z0000000000000', hostedZoneName: 'example.com' };
const synth = (props: Omit<PerTenantObservabilityStackProps, 'env'>) =>
  Template.fromStack(new PerTenantObservabilityStack(new cdk.App(), 'TestStack', { env, ...props }));

describe('demo mode (default settings)', () => {
  const template = synth({ demo });

  test('creates a tenant-only distribution with three tenants on a dedicated connection group', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: { ConnectionMode: 'tenant-only' },
    });
    template.resourceCountIs('AWS::CloudFront::DistributionTenant', 3);
    template.resourceCountIs('AWS::CloudFront::ConnectionGroup', 1);
    template.hasResourceProperties('AWS::CloudFront::DistributionTenant', {
      Domains: ['tenant-a.tenants.example.com'],
    });
  });

  test('demo has no log delivery alarm by default, and can turn it on', () => {
    expect(Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { AlarmName: 'TestStack-no-access-logs' } }))).toHaveLength(0);
    synth({ demo, noLogsAlarmMinutes: 15 }).hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'TestStack-no-access-logs', Period: 900 });
  });

  test('origin function logs are deleted with the stack', () => {
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete', Properties: { RetentionInDays: 7 } });
  });

  test('origin function role writes only to its own log group, with no managed policies', () => {
    const roles = template.findResources('AWS::IAM::Role', {
      Properties: { AssumeRolePolicyDocument: { Statement: [{ Principal: { Service: 'lambda.amazonaws.com' } }] } },
    });
    const origin = Object.entries(roles).find(([id]) => id.startsWith('DemoOriginFunctionRole'));
    expect(origin).toBeDefined();
    expect(origin![1].Properties.ManagedPolicyArns).toBeUndefined();
    expect(JSON.stringify(origin![1].Properties.Policies)).toContain('DemoOriginFunctionLogs');
  });

  test('deletes the log bucket with the demo stack', () => {
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  });

  test('dashboard ranking widgets point at the rules this stack creates', () => {
    const ruleNames = Object.values(template.findResources('AWS::CloudWatch::InsightRule')).map((r) => r.Properties.RuleName).sort();
    const [dashboard] = Object.values(template.findResources('AWS::CloudWatch::Dashboard'));
    const body = JSON.stringify(dashboard.Properties.DashboardBody);
    const widgetRules = [...body.matchAll(/\\"ruleName\\":\\"([^\\"]+)\\"/g)].map((m) => m[1]).sort();
    expect(widgetRules).toEqual(ruleNames);
  });

  test('tenant alarm reads the metrics its metric filters write', () => {
    const filters = Object.values(template.findResources('AWS::Logs::MetricFilter'));
    for (const f of filters) {
      const t = f.Properties.MetricTransformations[0];
      expect(t.Dimensions).toEqual([{ Key: 'TenantId', Value: '$.distribution-tenant-id' }]);
      expect(t.MetricNamespace).toBe('PerTenantObservability');
    }
    const [alarm] = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
    const metrics = alarm.Properties.Metrics.filter((m: any) => m.MetricStat);
    expect(metrics.map((m: any) => m.MetricStat.Metric.MetricName).sort()).toEqual(['Requests', 'ServerErrors']);
    for (const m of metrics) {
      expect(m.MetricStat.Metric.Dimensions).toEqual([{ Name: 'TenantId', Value: { 'Fn::GetAtt': [expect.stringMatching(/^DemoTenanttenantb/), 'Id'] } }]);
    }
  });

  test('InvokeFunction permission is limited to calls through the function URL', () => {
    template.hasResourceProperties('AWS::Lambda::Permission', { Action: 'lambda:InvokeFunction', InvokedViaFunctionUrl: true });
  });

  test('origin function allows only this distribution', () => {
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission', {
      Properties: { Principal: 'cloudfront.amazonaws.com' },
    }));
    expect(permissions).toHaveLength(2);
    for (const permission of permissions) {
      expect(JSON.stringify(permission.Properties.SourceArn)).toContain('DemoMultiTenantDistribution');
    }
  });

  test('delivers standard logs to CloudWatch Logs as JSON and to S3 as Parquet', () => {
    template.hasResourceProperties('AWS::Logs::DeliverySource', { LogType: 'ACCESS_LOGS' });
    template.hasResourceProperties('AWS::Logs::DeliveryDestination', { OutputFormat: 'json' });
    template.hasResourceProperties('AWS::Logs::DeliveryDestination', { OutputFormat: 'parquet' });
  });

  test('creates the default rankings keyed on the tenant ID, without the bytes ranking', () => {
    const rules = template.findResources('AWS::CloudWatch::InsightRule');
    expect(Object.keys(rules)).toHaveLength(3);
    const body = JSON.stringify(rules);
    expect(body).toContain('distribution-tenant-id');
    expect(body).not.toContain('sc-bytes');
  });

  test('alarms only on selected tenants, matching 5xx as a string', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
    template.resourceCountIs('AWS::Logs::MetricFilter', 2);
    const filters = JSON.stringify(template.findResources('AWS::Logs::MetricFilter'));
    expect(filters).toContain('$.sc-status = \\"5*\\"');
    expect(filters).not.toMatch(/sc-status\s*>=/);
  });

  test('Athena table projects hourly partitions and has three saved queries', () => {
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: { Parameters: { 'projection.enabled': 'true', 'projection.dt.type': 'date' } },
    });
    template.resourceCountIs('AWS::Athena::NamedQuery', 3);
    template.hasResourceProperties('AWS::Athena::WorkGroup', { RecursiveDeleteOption: true });
  });
});

describe('log retention, fields, and permissions', () => {
  const template = synth({ demo });
  const queries = () => Object.values(template.findResources('AWS::Athena::NamedQuery'))
    .map((q) => JSON.stringify(q.Properties.QueryString));

  test('keeps S3 logs for 90 days and projects partitions over the same range', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: [{ ExpirationInDays: 90, Status: 'Enabled' }] },
    });
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: { Parameters: { 'projection.dt.range': 'NOW-90DAYS,NOW' } },
    });
  });

  test('sends only the fields the near real-time views read to CloudWatch Logs', () => {
    template.hasResourceProperties('AWS::Logs::Delivery', {
      RecordFields: ['distribution-tenant-id', 'sc-status', 'sc-bytes', 'x-edge-result-type'],
    });
  });

  test('lets log delivery write only under the AWSLogs prefix', () => {
    const [policy] = Object.values(template.findResources('AWS::S3::BucketPolicy'));
    const statements: any[] = policy.Properties.PolicyDocument.Statement;
    const delivery = statements.filter((st) => JSON.stringify(st.Principal).includes('delivery.logs.amazonaws.com'));
    expect(delivery).toHaveLength(1);
    expect(JSON.stringify(delivery[0].Resource)).toMatch(/"\/AWSLogs\/111111111111\/\*"\]\]\}$/);
  });

  test('Athena reads the same folder layout that log delivery writes', () => {
    const deliveries = Object.values(template.findResources('AWS::Logs::Delivery'))
      .filter((d) => d.Properties.S3SuffixPath !== undefined);
    expect(deliveries).toHaveLength(1);
    const [delivery] = deliveries;
    const [table] = Object.values(template.findResources('AWS::Glue::Table'));
    const params = table.Properties.TableInput.Parameters;
    // {DistributionId}/{yyyy}/{MM}/{dd}/{HH} must line up with <prefix>/<distribution-id>/${dt}/ and yyyy/MM/dd/HH.
    expect(delivery.Properties.S3SuffixPath).toBe('{DistributionId}/{yyyy}/{MM}/{dd}/{HH}');
    expect(delivery.Properties.S3EnableHiveCompatiblePath).toBe(false);
    expect(params['projection.dt.format']).toBe('yyyy/MM/dd/HH');
    const template_ = JSON.stringify(params['storage.location.template']);
    expect(template_).toContain('/AWSLogs/111111111111/CloudFront/');
    expect(template_).toContain('/${dt}/');
    // Same bucket and distribution as the log delivery.
    expect(template_).toContain('LogsAccessLogBucket');
    expect(template_).toContain('DemoMultiTenantDistribution');
  });

  test('tenant alarm needs a minimum request count and 2 of 3 breaching periods', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { EvaluationPeriods: 3, DatapointsToAlarm: 2 });
    expect(JSON.stringify(template.findResources('AWS::CloudWatch::Alarm'))).toContain('IF(requests >= 20');
  });

  test('reports group by request date, with folder-hour pruning', () => {
    const sql = queries().join('\n');
    expect(sql).toContain('SUBSTR(l.date, 1, 7) AS month');
    expect(sql).toContain("l.date >= date_format(date_trunc('month', current_timestamp) - INTERVAL '1' MONTH, '%Y-%m-%d')");
    expect(sql).toContain("l.date >= date_format(date_trunc('day', current_timestamp) - INTERVAL '7' DAY, '%Y-%m-%d')");
  });

  test('Glue database names stay distinct for stack names that differ only by case', () => {
    const db = (name: string) => JSON.stringify(Template.fromStack(new PerTenantObservabilityStack(new cdk.App(), name, { env, demo }))
      .findResources('AWS::Glue::Database'));
    expect(db('TenantsShop')).not.toEqual(db('tenantsshop'));
  });

  test('alarm topic accepts only TLS', () => {
    const t = synth({ demo, alarmEmail: 'ops@example.com' });
    const policy = JSON.stringify(t.findResources('AWS::SNS::TopicPolicy'));
    expect(policy).toContain('aws:SecureTransport');
    // enforceSSL replaces the default topic policy, so the alarms need an explicit Allow.
    const statements = Object.values(t.findResources('AWS::SNS::TopicPolicy'))[0].Properties.PolicyDocument.Statement;
    const allow = statements.find((st: any) => st.Effect === 'Allow' && st.Principal?.Service === 'cloudwatch.amazonaws.com');
    expect(allow.Action).toBe('sns:Publish');
    expect(JSON.stringify(allow.Condition.ArnLike['aws:SourceArn'])).toContain(':alarm:TestStack-*');
  });

  test('alarm topic is encrypted with a key that only this stack\'s alarms can use', () => {
    const t = synth({ demo, alarmEmail: 'ops@example.com' });
    const [topic] = Object.values(t.findResources('AWS::SNS::Topic'));
    const [keyId] = Object.keys(t.findResources('AWS::KMS::Key'));
    expect(topic.Properties.KmsMasterKeyId).toEqual({ 'Fn::GetAtt': [keyId, 'Arn'] });
    t.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true, PendingWindowInDays: 7 });
    const statements = Object.values(t.findResources('AWS::KMS::Key'))[0].Properties.KeyPolicy.Statement;
    const cw = statements.find((st: any) => st.Principal?.Service === 'cloudwatch.amazonaws.com');
    expect(cw.Action).toEqual(['kms:Decrypt', 'kms:GenerateDataKey*']);
    expect(cw.Condition.StringEquals['aws:SourceAccount']).toBe('111111111111');
    expect(JSON.stringify(cw.Condition.ArnLike['aws:SourceArn'])).toContain(':alarm:TestStack-*');
    const [alarm] = Object.values(t.findResources('AWS::CloudWatch::Alarm'));
    expect(alarm.Properties.AlarmName).toMatch(/^TestStack-/);
  });

  test('no alarm topic or key without alarmEmail', () => {
    const t = synth({ demo });
    t.resourceCountIs('AWS::SNS::Topic', 0);
    t.resourceCountIs('AWS::KMS::Key', 0);
  });

  test('reports p90 response time and covers last month for chargeback', () => {
    const sql = queries().join('\n');
    expect(sql).toContain('APPROX_PERCENTILE');
    expect(sql).toContain("l.dt >= date_format(date_trunc('day', current_timestamp) - INTERVAL '7' DAY, '%Y/%m/%d/%H')");
    expect(sql).toContain("INTERVAL '1' MONTH");
  });
});

describe('scanner suppressions', () => {
  const template = synth({ demo, alarmEmail: 'ops@example.com' });
  test.each([
    ['AWS::CloudFront::Distribution', ['CKV_AWS_68', 'CKV_AWS_86']],
    ['AWS::S3::Bucket', ['CKV_AWS_18', 'CKV_AWS_21']],
    ['AWS::Lambda::Function', ['CKV_AWS_115', 'CKV_AWS_116', 'CKV_AWS_117']],
  ])('%s carries checkov skips with reasons', (type, ids) => {
    const resources = Object.values(template.findResources(type));
    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) {
      const skips = r.Metadata.checkov.skip;
      expect(skips.map((s: any) => s.id)).toEqual(ids);
      for (const s of skips) expect(s.comment.length).toBeGreaterThan(20);
    }
  });
});

describe('reports-only mode (nearRealTime=false)', () => {
  const template = synth({ demo, nearRealTime: false });

  test('keeps only the S3 delivery and Athena reports', () => {
    template.resourceCountIs('AWS::Logs::Delivery', 1);
    const accessLogGroups = Object.values(template.findResources('AWS::Logs::LogGroup'))
      .filter((r) => JSON.stringify(r).includes('/aws/vendedlogs/'));
    expect(accessLogGroups).toHaveLength(0);
    template.resourceCountIs('AWS::Logs::ResourcePolicy', 0);
    template.resourceCountIs('AWS::CloudWatch::InsightRule', 0);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 0);
    template.resourceCountIs('AWS::Athena::NamedQuery', 3);
  });
});

describe('existing distribution mode', () => {
  const template = synth({
    distributionId: 'E1234567890ABC',
    tenants: [{ name: 'shop-one', id: 'dt_one' }, { name: 'shop-two', id: 'dt_two' }],
    alarmedTenantNames: ['shop-two'],
    rankingRules: ['requests', 'bytes'],
  });

  test('creates no demo resources and points log delivery at the given distribution', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
    template.resourceCountIs('AWS::CloudFront::DistributionTenant', 0);
    template.resourceCountIs('AWS::Lambda::Function', 0); // no demo origin, and the bucket is retained
    template.hasResourceProperties('AWS::Logs::DeliverySource', {
      ResourceArn: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':cloudfront::111111111111:distribution/E1234567890ABC']] },
    });
  });

  test('keeps the log bucket and its files when the stack is deleted', () => {
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  test('uses the selected rankings and alarms on the named tenant', () => {
    template.resourceCountIs('AWS::CloudWatch::InsightRule', 2);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'TestStack-shop-two-5xx-rate' });
  });

  test('writes valid tenant name lookups, escaping quotes', () => {
    const t = synth({ distributionId: 'E1', tenants: [{ name: "o'brien", id: 'dt_1' }] });
    const sql = JSON.stringify(t.findResources('AWS::Athena::NamedQuery'));
    expect(sql).toContain("('dt_1', 'o''brien')");
  });

  test('builds valid queries when no tenant list is passed', () => {
    const t = synth({ distributionId: 'E1' });
    const sql = JSON.stringify(t.findResources('AWS::Athena::NamedQuery'));
    expect(sql).not.toMatch(/VALUES\s*\)/);
    expect(sql).toContain('WHERE FALSE');
  });

  test('rejects tenant alarms when the near real-time path is off', () => {
    expect(() => synth({ distributionId: 'E1', tenants: [{ name: 'a', id: 'dt_1' }], nearRealTime: false, alarmedTenantNames: ['a'] }))
      .toThrow(/near real-time path/);
  });

  test('alarms when no log events arrive for 60 minutes by default', () => {
    const [[alarmId, alarm]] = Object.entries(template.findResources('AWS::CloudWatch::Alarm', { Properties: { AlarmName: 'TestStack-no-access-logs' } }));
    expect(alarm.Properties).toMatchObject({
      Namespace: 'AWS/Logs', MetricName: 'IncomingLogEvents', Statistic: 'Sum', Period: 3600,
      Threshold: 1, ComparisonOperator: 'LessThanThreshold', EvaluationPeriods: 1, TreatMissingData: 'breaching',
    });
    const [logGroupId] = Object.keys(template.findResources('AWS::Logs::LogGroup', { Properties: { LogGroupName: '/aws/vendedlogs/cloudfront/TestStack' } }));
    expect(alarm.Properties.Dimensions).toEqual([{ Name: 'LogGroupName', Value: { Ref: logGroupId } }]);
    expect(JSON.stringify(template.findResources('AWS::CloudWatch::Dashboard'))).toContain(alarmId);
  });

  test('noLogsAlarmMinutes=0 turns the log delivery alarm off, and the alarm notifies the topic', () => {
    const base = { distributionId: 'E1', tenants: [{ name: 'a', id: 'dt_1' }] };
    synth({ ...base, noLogsAlarmMinutes: 0 }).resourceCountIs('AWS::CloudWatch::Alarm', 0);
    const t = synth({ ...base, noLogsAlarmMinutes: 15, alarmEmail: 'ops@example.com' });
    const [alarm] = Object.values(t.findResources('AWS::CloudWatch::Alarm'));
    expect(alarm.Properties.Period).toBe(900);
    const [topicId] = Object.keys(t.findResources('AWS::SNS::Topic'));
    expect(alarm.Properties.AlarmActions).toEqual([{ Ref: topicId }]);
  });

  test('rejects the log delivery alarm when the near real-time path is off', () => {
    expect(() => synth({ distributionId: 'E1', nearRealTime: false, noLogsAlarmMinutes: 60 })).toThrow(/log delivery alarm needs/);
  });

  test('rejects alarmed tenants that are not in the tenant list', () => {
    expect(() => synth({ distributionId: 'E1', tenants: [], alarmedTenantNames: ['missing'] }))
      .toThrow(/not found in the tenant list/);
  });
});
