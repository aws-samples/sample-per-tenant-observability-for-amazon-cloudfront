import * as cdk from 'aws-cdk-lib/core';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { DemoTenants } from './demo-tenants';
import { DEFAULT_LOG_RETENTION_DAYS, LogDelivery } from './log-delivery';
import { RankingRule, TenantObservability, TenantRef } from './tenant-observability';
import { ScannerSuppressions } from './scanner-suppressions';
import { UsageReports } from './usage-reports';

export interface DemoOptions {
  readonly hostedZoneId: string;
  readonly hostedZoneName: string;
  /** Subdomain for tenant domains. Default: "tenants". */
  readonly tenantSubdomain?: string;
  /** Default: tenant-a, tenant-b, tenant-c. */
  readonly tenantNames?: string[];
}

export interface PerTenantObservabilityStackProps extends cdk.StackProps {
  /**
   * ID of your existing multi-tenant distribution. Leave unset to create a demo
   * distribution with tenants instead (requires `demo`).
   */
  readonly distributionId?: string;
  /** Tenants of the existing distribution (name and ID), for names in the dashboard, reports, and alarms. */
  readonly tenants?: TenantRef[];
  readonly demo?: DemoOptions;
  /**
   * Near real-time views: CloudWatch Logs delivery, Contributor Insights rules, tenant
   * alarms, and the dashboard. Set to false to keep only the S3 and Athena usage reports,
   * which removes the Contributor Insights, custom metric, alarm, and log storage charges.
   * Default: true.
   */
  readonly nearRealTime?: boolean;
  /** Contributor Insights rankings to create. Default: requests, errors, cacheMisses. */
  readonly rankingRules?: RankingRule[];
  /** Names of tenants that get their own metrics and 5xx error rate alarm. */
  readonly alarmedTenantNames?: string[];
  /** 5xx error rate (percent) that triggers a tenant alarm. Default: 5. */
  readonly errorRateThreshold?: number;
  /** Requests per 5 minutes a tenant needs before its error rate counts. Default: 20. */
  readonly alarmMinRequests?: number;
  /** Optional email address for alarm notifications. */
  readonly alarmEmail?: string;
  /**
   * Minutes without any log events before the log delivery alarm goes to ALARM. 0 turns
   * the alarm off. Default: 60 for an existing distribution, 0 for the demo (the demo
   * distribution has no traffic until you run the traffic script).
   */
  readonly noLogsAlarmMinutes?: number;
  /**
   * Delete the S3 log bucket and its files when the stack is deleted. Default: true for
   * the demo, false for an existing distribution, so usage history is kept.
   */
  readonly deleteLogsOnDestroy?: boolean;
  /** Days to keep log files in Amazon S3 for the usage reports. Default: 90. */
  readonly logRetentionDays?: number;
}

/**
 * Per-tenant observability for a CloudFront multi-tenant distribution: standard logs (v2)
 * delivery, Contributor Insights rankings, alarms for selected tenants, a dashboard, and
 * Athena usage reports. Optionally creates a demo distribution with tenants.
 */
export class PerTenantObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PerTenantObservabilityStackProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('sample', 'per-tenant-observability');
    cdk.Aspects.of(this).add(new ScannerSuppressions());

    let distributionId: string;
    let tenants: TenantRef[];
    if (props.distributionId) {
      distributionId = props.distributionId;
      tenants = props.tenants ?? [];
    } else {
      if (!props.demo) throw new Error('Set distributionId for an existing distribution, or demo options to create one.');
      const tenantNames = props.demo.tenantNames ?? ['tenant-a', 'tenant-b', 'tenant-c'];
      const demo = new DemoTenants(this, 'Demo', {
        hostedZone: route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
          hostedZoneId: props.demo.hostedZoneId,
          zoneName: props.demo.hostedZoneName,
        }),
        tenantSubdomain: props.demo.tenantSubdomain ?? 'tenants',
        tenantNames,
      });
      distributionId = demo.distribution.ref;
      tenants = demo.tenants.map((t, i) => ({ id: t.attrId, name: tenantNames[i] }));
      new cdk.CfnOutput(this, 'TenantDomains', { value: demo.tenantDomains.join(',') });
    }
    const distributionArn = `arn:${this.partition}:cloudfront::${this.account}:distribution/${distributionId}`;
    const nearRealTime = props.nearRealTime ?? true;
    if (!nearRealTime && props.alarmedTenantNames?.length) {
      throw new Error('Tenant alarms need the near real-time path. Remove alarmedTenants or set nearRealTime to true.');
    }
    if (!nearRealTime && props.noLogsAlarmMinutes) {
      throw new Error('The log delivery alarm needs the near real-time path. Remove noLogsAlarmMinutes or set nearRealTime to true.');
    }
    const retentionDays = props.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
    if (retentionDays < 62) {
      cdk.Annotations.of(this).addWarningV2('per-tenant-observability:shortRetention',
        `logRetentionDays is ${retentionDays}. The chargeback query needs at least 62 days to cover the full previous month.`);
    }

    const logDelivery = new LogDelivery(this, 'Logs', {
      distributionArn,
      cloudWatch: nearRealTime,
      deleteLogsOnDestroy: props.deleteLogsOnDestroy ?? !props.distributionId,
      s3RetentionDays: retentionDays,
    });

    if (nearRealTime && logDelivery.logGroup) {
      const alarmedNames = props.alarmedTenantNames ?? (props.distributionId ? [] : ['tenant-b']);
      const unknown = alarmedNames.filter((name) => !tenants.some((t) => t.name === name));
      if (unknown.length) throw new Error(`Alarmed tenants not found in the tenant list: ${unknown.join(', ')}`);

      const observability = new TenantObservability(this, 'Observability', {
        logGroup: logDelivery.logGroup,
        distributionId,
        tenants,
        rankingRules: props.rankingRules,
        alarmedTenants: tenants.filter((t) => alarmedNames.includes(t.name)),
        errorRateThreshold: props.errorRateThreshold,
        alarmMinRequests: props.alarmMinRequests,
        alarmEmail: props.alarmEmail,
        noLogsAlarmMinutes: props.noLogsAlarmMinutes ?? (props.distributionId ? 60 : 0),
      });
      new cdk.CfnOutput(this, 'DashboardUrl', {
        value: `https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards/dashboard/${observability.dashboard.ref}`,
      });
      new cdk.CfnOutput(this, 'AccessLogGroup', { value: logDelivery.logGroup.logGroupName });
    }

    const reports = new UsageReports(this, 'Reports', { bucket: logDelivery.bucket, distributionId, tenants, retentionDays });

    new cdk.CfnOutput(this, 'DistributionId', { value: distributionId });
    new cdk.CfnOutput(this, 'AccessLogBucket', { value: logDelivery.bucket.bucketName });
    new cdk.CfnOutput(this, 'AthenaWorkGroup', { value: reports.workGroupName });
  }
}
