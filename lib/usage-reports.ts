import { createHash } from 'crypto';
import * as cdk from 'aws-cdk-lib/core';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { S3_PARTITION_FORMAT } from './log-delivery';
import { TenantRef } from './tenant-observability';

export interface UsageReportsProps {
  /** Bucket that receives the Parquet access logs. */
  readonly bucket: s3.IBucket;
  readonly distributionId: string;
  readonly tenants: TenantRef[];
  /** Days of log files kept in the bucket; the partition projection covers the same range. */
  readonly retentionDays: number;
}

/**
 * Athena table over the Parquet access logs, with saved queries for per-tenant
 * usage (requests, bytes, error rate, cache hit rate) and chargeback.
 */
export class UsageReports extends Construct {
  public readonly workGroupName: string;

  constructor(scope: Construct, id: string, props: UsageReportsProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    // Glue names are lowercase. A short hash of the exact stack name keeps stacks whose names
    // differ only by case or punctuation from sharing a database.
    const nameHash = createHash('sha256').update(stack.stackName).digest('hex').slice(0, 6);
    const databaseName = `${stack.stackName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_${nameHash}_logs`;
    const tableName = 'access_logs';

    const database = new glue.CfnDatabase(this, 'Database', {
      catalogId: stack.account,
      databaseInput: { name: databaseName },
    });

    // Standard logging (v2) writes to AWSLogs/<account>/CloudFront/<distribution-id>/YYYY/MM/DD/HH/
    const prefix = `s3://${props.bucket.bucketName}/AWSLogs/${stack.account}/CloudFront/${props.distributionId}`;
    const columns = [
      'date', 'time', 'distribution_tenant_id', 'cs_uri_stem', 'sc_status', 'sc_bytes',
      'time_taken', 'x_edge_result_type', 'x_edge_location', 'c_country',
    ];

    const table = new glue.CfnTable(this, 'Table', {
      catalogId: stack.account,
      databaseName,
      tableInput: {
        name: tableName,
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [{ name: 'dt', type: 'string' }],
        parameters: {
          classification: 'parquet',
          // Partition projection over the hourly folders: no crawler or MSCK REPAIR needed,
          // and filters on dt only read the matching hours.
          'projection.enabled': 'true',
          'projection.dt.type': 'date',
          'projection.dt.format': S3_PARTITION_FORMAT,
          'projection.dt.range': `NOW-${props.retentionDays}DAYS,NOW`,
          'projection.dt.interval': '1',
          'projection.dt.interval.unit': 'HOURS',
          'storage.location.template': `${prefix}/\${dt}/`,
        },
        storageDescriptor: {
          location: `${prefix}/`,
          // The log delivery writes every field as a string.
          columns: columns.map((name) => ({ name, type: 'string' })),
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' },
        },
      },
    });
    table.addResourceDependency(database);

    const workGroup = new athena.CfnWorkGroup(this, 'WorkGroup', {
      name: `${stack.stackName}-tenants`,
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        resultConfiguration: {
          outputLocation: `s3://${props.bucket.bucketName}/athena-results/`,
          encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        },
      },
    });
    this.workGroupName = workGroup.name;

    // Tenant names are added to the queries at deploy time, so results show names, not only IDs.
    // Without a tenant list, the queries show tenant IDs.
    const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const withTenants = props.tenants.length
      ? `WITH tenants(tenant_id, tenant_name) AS (VALUES ${props.tenants.map((t) => `(${sqlString(t.id)}, ${sqlString(t.name)})`).join(', ')})`
      : 'WITH tenants(tenant_id, tenant_name) AS (SELECT CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR) WHERE FALSE)';
    const source = `"${databaseName}"."${tableName}"`;

    const queries = [
      {
        name: 'Daily usage per tenant (last 7 days and today)',
        description: 'Requests, bytes, 5xx error rate, cache hit rate, and p90 response time per tenant per day.',
        sql: `${withTenants}
SELECT
  COALESCE(t.tenant_name, l.distribution_tenant_id) AS tenant,
  l.date,
  COUNT(*) AS requests,
  SUM(CAST(l.sc_bytes AS BIGINT)) AS bytes_served,
  ROUND(100.0 * COUNT_IF(l.sc_status LIKE '5%') / COUNT(*), 2) AS error_rate_5xx_pct,
  ROUND(100.0 * COUNT_IF(l.x_edge_result_type IN ('Hit', 'RefreshHit')) / COUNT(*), 2) AS cache_hit_pct,
  ROUND(APPROX_PERCENTILE(CAST(l.time_taken AS DOUBLE), 0.9), 3) AS p90_seconds
FROM ${source} l
LEFT JOIN tenants t ON l.distribution_tenant_id = t.tenant_id
-- dt (the folder hour) prunes the scan; date is the request date. A late record lands in a later folder,
-- which the open-ended dt filter still reads.
WHERE l.dt >= date_format(date_trunc('day', current_timestamp) - INTERVAL '7' DAY, '%Y/%m/%d/%H')
  AND l.date >= date_format(date_trunc('day', current_timestamp) - INTERVAL '7' DAY, '%Y-%m-%d')
GROUP BY 1, 2
ORDER BY 2 DESC, 3 DESC;`,
      },
      {
        name: 'Monthly data transfer per tenant (chargeback)',
        description: 'Requests and gigabytes (10^9 bytes) served per tenant, for last month and this month to date.',
        sql: `${withTenants}
SELECT
  COALESCE(t.tenant_name, l.distribution_tenant_id) AS tenant,
  SUBSTR(l.date, 1, 7) AS month,
  COUNT(*) AS requests,
  ROUND(SUM(CAST(l.sc_bytes AS BIGINT)) / 1e9, 3) AS gb_served
FROM ${source} l
LEFT JOIN tenants t ON l.distribution_tenant_id = t.tenant_id
-- dt (the folder hour) prunes the scan; date is the request date. A late record lands in a later folder,
-- which the open-ended dt filter still reads.
WHERE l.dt >= date_format(date_trunc('month', current_timestamp) - INTERVAL '1' MONTH, '%Y/%m/%d/%H')
  AND l.date >= date_format(date_trunc('month', current_timestamp) - INTERVAL '1' MONTH, '%Y-%m-%d')
GROUP BY 1, 2
ORDER BY 2 DESC, 4 DESC;`,
      },
      {
        name: 'Top error paths per tenant (last 24 hours)',
        description: 'Paths that returned 5xx, by tenant, to start an investigation.',
        sql: `${withTenants}
SELECT
  COALESCE(t.tenant_name, l.distribution_tenant_id) AS tenant,
  l.cs_uri_stem AS path,
  l.sc_status,
  COUNT(*) AS errors
FROM ${source} l
LEFT JOIN tenants t ON l.distribution_tenant_id = t.tenant_id
WHERE l.sc_status LIKE '5%'
  AND l.dt >= date_format(current_timestamp - INTERVAL '1' DAY, '%Y/%m/%d/%H')
GROUP BY 1, 2, 3
ORDER BY 4 DESC
LIMIT 50;`,
      },
    ];

    queries.forEach((query, i) => {
      const named = new athena.CfnNamedQuery(this, `Query${i}`, {
        name: query.name,
        description: query.description,
        database: databaseName,
        workGroup: workGroup.name,
        queryString: query.sql,
      });
      named.addResourceDependency(workGroup);
      named.addResourceDependency(table);
    });
  }
}
