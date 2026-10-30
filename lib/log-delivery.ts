import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Fields delivered to CloudWatch Logs: only what the Contributor Insights rules and metric
 * filters read. CloudFront includes 750 bytes of log delivery to CloudWatch Logs per request
 * at no additional charge, and these records are far below that. Paths, locations, and
 * response times stay in the S3 copy for Athena. cs(Host) is left out: on a multi-tenant
 * distribution it holds the connection group endpoint, not the tenant domain.
 */
export const CLOUDWATCH_FIELDS = [
  'distribution-tenant-id', 'sc-status', 'sc-bytes', 'x-edge-result-type',
];

/**
 * Hourly folders under the distribution ID. CloudFront adds AWSLogs/<account>/CloudFront/
 * in front when the destination is a bucket without a prefix. The Athena partition
 * projection reads the same layout (see S3_PARTITION_FORMAT).
 */
export const S3_SUFFIX_PATH = '{DistributionId}/{yyyy}/{MM}/{dd}/{HH}';
export const S3_PARTITION_FORMAT = 'yyyy/MM/dd/HH';

/** Days to keep log files in Amazon S3. 90 days covers the previous full month for chargeback. */
export const DEFAULT_LOG_RETENTION_DAYS = 90;

/** Fields delivered to Amazon S3 for usage reports. */
export const S3_FIELDS = [
  'date', 'time', 'distribution-tenant-id', 'cs-uri-stem', 'sc-status', 'sc-bytes',
  'time-taken', 'x-edge-result-type', 'x-edge-location', 'c-country',
];

export interface LogDeliveryProps {
  /** ARN of the multi-tenant distribution. */
  readonly distributionArn: string;
  /** Deliver to CloudWatch Logs for near real-time views. Default: true. */
  readonly cloudWatch?: boolean;
  /** Retention for the CloudWatch Logs copy. Default: two weeks. */
  readonly retention?: logs.RetentionDays;
  /** Days to keep log files in Amazon S3. Default: 90. */
  readonly s3RetentionDays?: number;
  /**
   * Delete the S3 bucket and its log files when the stack is deleted. Set to false to
   * keep usage history for chargeback after you remove the stack. Default: true.
   */
  readonly deleteLogsOnDestroy?: boolean;
}

/**
 * Standard logging (v2) for the distribution: Parquet files to Amazon S3 for usage
 * reports and, optionally, JSON records to CloudWatch Logs for near real-time views.
 */
export class LogDelivery extends Construct {
  public readonly logGroup?: logs.LogGroup;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: LogDeliveryProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const deliverySourceArnPattern = `arn:${stack.partition}:logs:${stack.region}:${stack.account}:delivery-source:*`;

    const deleteLogs = props.deleteLogsOnDestroy ?? true;
    // This bucket holds access logs itself, so it has no server access logging of its own.
    this.bucket = new s3.Bucket(this, 'AccessLogBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: cdk.Duration.days(props.s3RetentionDays ?? DEFAULT_LOG_RETENTION_DAYS) }],
      removalPolicy: deleteLogs ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: deleteLogs,
    });
    cdk.Validations.of(this.bucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'This bucket stores CloudFront access logs. Logging access to it would need a second log bucket and adds no value for this sample.',
    });
    this.bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AWSLogDeliveryWrite',
      principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:PutObject'],
      // Only the prefix that standard logging (v2) writes to, not the Athena results.
      resources: [this.bucket.arnForObjects(`AWSLogs/${stack.account}/*`)],
      conditions: {
        StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control', 'aws:SourceAccount': stack.account },
        ArnLike: { 'aws:SourceArn': deliverySourceArnPattern },
      },
    }));

    const source = new logs.CfnDeliverySource(this, 'Source', {
      name: `${stack.stackName}-access-logs`,
      resourceArn: props.distributionArn,
      logType: 'ACCESS_LOGS',
    });

    const s3Destination = new logs.CfnDeliveryDestination(this, 'S3Destination', {
      name: `${stack.stackName}-s3`,
      destinationResourceArn: this.bucket.bucketArn,
      outputFormat: 'parquet',
    });
    s3Destination.node.addDependency(this.bucket.policy!);

    const s3Delivery = new logs.CfnDelivery(this, 'S3Delivery', {
      deliverySourceName: source.ref,
      deliveryDestinationArn: s3Destination.attrArn,
      recordFields: S3_FIELDS,
      // Plain hourly folders (YYYY/MM/DD/HH) match the Athena date partition projection.
      s3EnableHiveCompatiblePath: false,
      s3SuffixPath: S3_SUFFIX_PATH,
    });

    if (props.cloudWatch ?? true) {
      const logGroup = new logs.LogGroup(this, 'AccessLogs', {
        logGroupName: `/aws/vendedlogs/cloudfront/${stack.stackName}`,
        retention: props.retention ?? logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      // Lets the log delivery service write to this log group only. This is an account-level
      // CloudWatch Logs resource policy; each account has a quota of 10 per Region.
      const logGroupPolicy = new logs.CfnResourcePolicy(this, 'LogGroupDeliveryPolicy', {
        policyName: `${stack.stackName}-cloudfront-log-delivery`,
        policyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{
            Sid: 'AWSLogDeliveryWrite',
            Effect: 'Allow',
            Principal: { Service: 'delivery.logs.amazonaws.com' },
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: `${logGroup.logGroupArn}`,
            Condition: {
              StringEquals: { 'aws:SourceAccount': stack.account },
              ArnLike: { 'aws:SourceArn': deliverySourceArnPattern },
            },
          }],
        }),
      });

      const cloudWatchDestination = new logs.CfnDeliveryDestination(this, 'CloudWatchDestination', {
        name: `${stack.stackName}-cwl`,
        destinationResourceArn: logGroup.logGroupArn,
        outputFormat: 'json',
      });
      const cloudWatchDelivery = new logs.CfnDelivery(this, 'CloudWatchDelivery', {
        deliverySourceName: source.ref,
        deliveryDestinationArn: cloudWatchDestination.attrArn,
        recordFields: CLOUDWATCH_FIELDS,
      });
      cloudWatchDelivery.node.addDependency(logGroupPolicy);

      // Create deliveries for the same source one at a time.
      s3Delivery.node.addDependency(cloudWatchDelivery);
      this.logGroup = logGroup;
    }
  }
}
