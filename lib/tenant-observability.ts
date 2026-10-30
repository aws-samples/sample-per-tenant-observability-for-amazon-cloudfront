import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export const METRIC_NAMESPACE = 'PerTenantObservability';

export const RANKING_RULES = ['requests', 'errors', 'bytes', 'cacheMisses'] as const;
export type RankingRule = (typeof RANKING_RULES)[number];

export interface TenantRef {
  readonly id: string;
  readonly name: string;
}

export interface TenantObservabilityProps {
  /** Log group that receives the distribution's standard logs (v2) as JSON. */
  readonly logGroup: logs.ILogGroup;
  readonly distributionId: string;
  /** All tenants, used for the ID-to-name table on the dashboard. */
  readonly tenants: TenantRef[];
  /**
   * Contributor Insights rankings to create. Each rule is billed per month plus per
   * matched log event. Default: requests, errors, cacheMisses (bytes is also in the
   * Athena reports).
   */
  readonly rankingRules?: RankingRule[];
  /**
   * Tenants that get their own metrics and alarm. Keep this list short: each tenant
   * adds two metric filters, and a log group supports a limited number of them.
   */
  readonly alarmedTenants: TenantRef[];
  /** 5xx error rate (percent) that triggers a tenant alarm. Default: 5. */
  readonly errorRateThreshold?: number;
  /**
   * Requests per 5 minutes that a tenant needs before its error rate counts, so a single
   * failed request at low traffic doesn't trigger the alarm. Default: 20.
   */
  readonly alarmMinRequests?: number;
  /** Optional email address for alarm notifications. */
  readonly alarmEmail?: string;
  /**
   * Minutes without any log events before the log delivery alarm goes to ALARM, so you
   * notice when log delivery stops. 0 or undefined: no log delivery alarm.
   */
  readonly noLogsAlarmMinutes?: number;
}

/**
 * Per-tenant views over the access logs:
 * - Contributor Insights rules rank all tenants (requests, 5xx errors, bytes, cache misses).
 * - Metric filters and an alarm watch a short list of selected tenants.
 * - A dashboard combines both with the distribution-level metrics.
 */
export class TenantObservability extends Construct {
  public readonly dashboard: cloudwatch.CfnDashboard;

  constructor(scope: Construct, id: string, props: TenantObservabilityProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const tenantKey = '$.distribution-tenant-id';

    // Log values are JSON strings (for example "sc-status":"500"), so match with
    // string operators. Numeric comparisons such as >= 500 match nothing.
    const enabled = new Set<RankingRule>(props.rankingRules ?? ['requests', 'errors', 'cacheMisses']);
    const rules = [
      { key: 'requests', id: 'Requests', title: 'Top tenants by requests', contribution: {}, aggregateOn: 'Count' },
      { key: 'errors', id: 'ServerErrors', title: 'Top tenants by 5xx errors',
        contribution: { Filters: [{ Match: '$.sc-status', StartsWith: ['5'] }] }, aggregateOn: 'Count' },
      { key: 'bytes', id: 'Bytes', title: 'Top tenants by bytes served',
        contribution: { ValueOf: '$.sc-bytes' }, aggregateOn: 'Sum' },
      { key: 'cacheMisses', id: 'CacheMisses', title: 'Top tenants by cache misses',
        contribution: { Filters: [{ Match: '$.x-edge-result-type', In: ['Miss'] }] }, aggregateOn: 'Count' },
    ].filter((rule) => enabled.has(rule.key as RankingRule)).map((rule) => {
      const ruleName = `${stack.stackName}-tenants-${rule.id}`;
      new cloudwatch.CfnInsightRule(this, `Rule${rule.id}`, {
        ruleName,
        ruleState: 'ENABLED',
        ruleBody: stack.toJsonString({
          Schema: { Name: 'CloudWatchLogRule', Version: 1 },
          LogGroupNames: [props.logGroup.logGroupName],
          LogFormat: 'JSON',
          // Filters is required by the rule schema, even when empty.
          Contribution: { Keys: [tenantKey], Filters: [], ...rule.contribution },
          AggregateOn: rule.aggregateOn,
        }),
      });
      return { ...rule, ruleName };
    });

    const topic = props.alarmEmail ? this.alarmTopic(props.alarmEmail) : undefined;

    const alarms = props.alarmedTenants.map((tenant) => {
      const dimensions = { TenantId: tenantKey };
      const filter = (metricId: string, pattern: string) => new logs.MetricFilter(this, `${tenant.name}-${metricId}`, {
        logGroup: props.logGroup,
        filterPattern: logs.FilterPattern.literal(pattern),
        metricNamespace: METRIC_NAMESPACE,
        metricName: metricId,
        metricValue: '1',
        dimensions,
      });
      filter('Requests', `{ ${tenantKey} = "${tenant.id}" }`);
      filter('ServerErrors', `{ (${tenantKey} = "${tenant.id}") && ($.sc-status = "5*") }`);

      const metric = (metricName: string) => new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE, metricName, dimensionsMap: { TenantId: tenant.id },
        statistic: 'Sum', period: cdk.Duration.minutes(5),
      });
      const errorRate = new cloudwatch.MathExpression({
        expression: `IF(requests >= ${props.alarmMinRequests ?? 20}, 100 * FILL(errors, 0) / requests, 0)`,
        usingMetrics: { requests: metric('Requests'), errors: metric('ServerErrors') },
        label: `${tenant.name} 5xx error rate (%)`,
        period: cdk.Duration.minutes(5),
      });
      const alarm = new cloudwatch.Alarm(this, `${tenant.name}-ErrorRateAlarm`, {
        alarmName: `${stack.stackName}-${tenant.name}-5xx-rate`,
        alarmDescription: `5xx error rate for tenant ${tenant.name} (${tenant.id}) is above ${props.errorRateThreshold ?? 5}%.`,
        metric: errorRate,
        threshold: props.errorRateThreshold ?? 5,
        // 2 of 3 periods: tolerates one period that looks quiet because logs arrived late.
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      if (topic) alarm.addAlarmAction(new cwActions.SnsAction(topic));
      return { tenant, alarm, errorRate };
    });

    // Tenant alarms treat missing data as not breaching, so they stay OK if log delivery
    // stops. This alarm covers that case: no log events at all for the whole period.
    const noLogsAlarm = props.noLogsAlarmMinutes ? new cloudwatch.Alarm(this, 'NoLogsAlarm', {
      alarmName: `${stack.stackName}-no-access-logs`,
      alarmDescription: `No access log events reached ${props.logGroup.logGroupName} in ${props.noLogsAlarmMinutes} minutes. Log delivery may have stopped, or the distribution received no requests.`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Logs', metricName: 'IncomingLogEvents',
        dimensionsMap: { LogGroupName: props.logGroup.logGroupName },
        statistic: 'Sum', period: cdk.Duration.minutes(props.noLogsAlarmMinutes),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }) : undefined;
    if (noLogsAlarm && topic) noLogsAlarm.addAlarmAction(new cwActions.SnsAction(topic));
    const alarmArns = [...alarms.map((a) => a.alarm.alarmArn), ...(noLogsAlarm ? [noLogsAlarm.alarmArn] : [])];

    const tenantTable = ['| Tenant | Tenant ID |', '|---|---|', ...props.tenants.map((t) => `| ${t.name} | ${t.id} |`)].join('\n');
    const tenantText = props.tenants.length
      ? `Contributor Insights shows tenant IDs. Use this table to map them to names.\n\n${tenantTable}`
      : 'Contributor Insights shows tenant IDs. Pass the tenants context value to show names here.';
    const widgets: object[] = [
      { type: 'text', x: 0, y: 0, width: 8, height: 6, properties: { markdown: `## Tenants\n${tenantText}` } },
      { type: 'metric', x: 8, y: 0, width: 16, height: 6,
        properties: {
          title: 'All tenants combined (built-in distribution metrics)', region: 'us-east-1', view: 'timeSeries', stat: 'Sum', period: 60,
          metrics: [
            ['AWS/CloudFront', 'Requests', 'DistributionId', props.distributionId, 'Region', 'Global'],
            ['AWS/CloudFront', '5xxErrorRate', 'DistributionId', props.distributionId, 'Region', 'Global', { stat: 'Average', yAxis: 'right' }],
          ],
        } },
      ...rules.map((rule, i) => ({
        type: 'metric', x: (i % 2) * 12, y: 6 + Math.floor(i / 2) * 6, width: 12, height: 6,
        properties: {
          title: rule.title, region: 'us-east-1', view: 'timeSeries', period: 60, stacked: false,
          insightRule: { maxContributorCount: 10, orderBy: 'Sum', ruleName: rule.ruleName },
          legend: { position: 'bottom' },
        },
      })),
      ...(alarmArns.length ? [{
        type: 'alarm', x: 0, y: 6 + Math.ceil(rules.length / 2) * 6, width: 24, height: 3,
        properties: { title: 'Alarms', alarms: alarmArns },
      }] : []),
    ];

    this.dashboard = new cloudwatch.CfnDashboard(this, 'Dashboard', {
      dashboardName: `${stack.stackName}-tenants`,
      dashboardBody: stack.toJsonString({ widgets }),
    });
  }

  /**
   * Topic for alarm notifications, encrypted with a customer managed key. CloudWatch alarms
   * can't publish to topics that use the AWS managed key for Amazon SNS, so the key policy
   * allows CloudWatch to use this key for this stack's alarms only.
   */
  private alarmTopic(email: string): sns.Topic {
    const stack = cdk.Stack.of(this);
    const key = new kms.Key(this, 'AlarmTopicKey', {
      description: `Encrypts the ${stack.stackName} alarm notification topic`,
      enableKeyRotation: true,
      pendingWindow: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const fromThisStacksAlarms = {
      StringEquals: { 'aws:SourceAccount': stack.account },
      ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:cloudwatch:${stack.region}:${stack.account}:alarm:${stack.stackName}-*` },
    };
    const cloudWatch = new iam.ServicePrincipal('cloudwatch.amazonaws.com');
    key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarms',
      principals: [cloudWatch],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
      conditions: fromThisStacksAlarms,
    }));
    const topic = new sns.Topic(this, 'AlarmTopic', { masterKey: key, enforceSSL: true });
    // enforceSSL replaces the default topic policy, so allow the alarms to publish explicitly.
    topic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarms',
      principals: [cloudWatch],
      actions: ['sns:Publish'],
      resources: [topic.topicArn],
      conditions: fromThisStacksAlarms,
    }));
    topic.addSubscription(new subscriptions.EmailSubscription(email));
    return topic;
  }
}
