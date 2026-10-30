# Per-Tenant Observability for Amazon CloudFront

This sample shows how to monitor each tenant of an Amazon CloudFront multi-tenant distribution (CloudFront SaaS Manager) separately. You can rank tenants by traffic and errors, alarm on the tenants you choose, and report usage per tenant for chargeback.

> **Disclaimer:** This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory, and compliance requirements before deployment.

## Background

With Amazon CloudFront SaaS Manager, a software as a service (SaaS) provider serves many customer domains from one multi-tenant distribution, with one distribution tenant per customer. Amazon CloudWatch publishes CloudFront metrics per distribution, so the built-in metrics show the combined traffic of all tenants. When the error rate rises, the built-in metrics don't show which tenant is affected.

CloudFront standard logs (v2) include a `distribution-tenant-id` field. This sample turns those logs into per-tenant views. The rankings and reports work for any number of tenants; the tenant name lookup suits up to a few hundred tenants (see [Settings](#settings)).

## Use cases

| Use case | Situation | What this sample provides |
|---|---|---|
| Find the affected tenant | The distribution's 5xx error rate rises, and on-call needs to know which tenant's origin has the issue | A ranking of tenants by 5xx errors |
| Watch key tenants | A tenant has a service level agreement, and you want an alarm when its error rate passes a threshold | Metrics and an alarm for the tenants you select |
| Charge back usage | You bill or allocate costs to each customer by the traffic they use | Monthly requests and gigabytes served per tenant, in Amazon Athena |
| Spot unusual traffic | One tenant's traffic grows sharply, from a promotion or from unwanted requests | Rankings by requests and cache misses |
| Answer customer questions | A customer reports slow pages | Per-tenant p90 response time, cache hit rate, and error paths |

If you serve a single site from a standard distribution, the built-in CloudFront metrics already cover these needs, and you don't need this sample.

### How this compares with other options

| Option | Fits when | Difference from this sample |
|---|---|---|
| [CloudFront distribution metrics](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/viewing-cloudfront-metrics.html), including the additional metrics | You need the health of the whole distribution | The metrics have `DistributionId` and `Region` dimensions only, so a multi-tenant distribution shows all tenants combined. This sample adds the tenant dimension from the logs, and its dashboard shows the distribution metrics next to the tenant rankings |
| [CloudFront real-time logs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/real-time-logs.html) to Amazon Kinesis Data Streams | You need records within seconds, or custom processing per request | You run a stream and a consumer that aggregates the records. This sample uses standard logs (v2), which CloudFront delivers within minutes to CloudWatch Logs and Amazon S3 without a stream or consumer to operate |
| One standard distribution per customer | Each customer needs its own distribution settings anyway | The built-in metrics are then per customer, but you give up the shared configuration and tenant management of CloudFront SaaS Manager |

## Architecture

![Architecture diagram: a CloudFront multi-tenant distribution sends standard logs (v2) to CloudWatch Logs, where Contributor Insights rules rank all tenants and metric filters drive alarms for selected tenants, and to Amazon S3 as Parquet, where an AWS Glue table and Amazon Athena queries report usage per tenant](architecture-diagram.png)

The editable source is [architecture-diagram.drawio](architecture-diagram.drawio).

## How it works

The distribution sends standard logs (v2) to two destinations. Each destination serves a different purpose, so you pay only for what each view needs.

1. **Rank all tenants (Amazon CloudWatch Contributor Insights).** CloudFront delivers JSON records with four fields to Amazon CloudWatch Logs. Contributor Insights rules use `distribution-tenant-id` as the key and show the top tenants by requests, 5xx errors, and cache misses. Contributor Insights handles a large number of distinct keys, so you don't create resources per tenant.
2. **Alarm on selected tenants (metric filters).** For each tenant you select, two metric filters count requests and 5xx errors, and an alarm watches the error rate over 5-minute periods. The alarm counts a period only when the tenant has at least 20 requests in it, and it goes to `ALARM` when 2 of 3 periods are above the threshold, so a single failed request or a late batch of logs doesn't trigger it. A log group supports up to 100 metric filters, so this approach covers up to about 50 tenants. Keep this list to the tenants that need an alarm. Use the rankings in step 1 to cover the rest.
3. **Report usage (Amazon S3 and Amazon Athena).** CloudFront delivers Parquet files to Amazon Simple Storage Service (Amazon S3) in hourly folders. An AWS Glue table with partition projection makes new hours queryable without a crawler. Saved Athena queries report daily usage and response times, monthly data transfer for chargeback, and the paths that returned errors. Log files are kept for 90 days by default, which covers the previous full month. The queries show tenant names, not only tenant IDs.

A CloudWatch dashboard combines the rankings, the alarms, and the distribution-level metrics.

### Things to know about the logs

These details came up while building this sample and can save you time:

- **Identify tenants by `distribution-tenant-id`, not by the host field.** On a multi-tenant distribution, `cs(Host)` contains the connection group endpoint (for example, `d111111abcdef8.cloudfront.net`), not the tenant's domain.
- **Log values are strings.** CloudFront writes every field as a JSON string, for example `"sc-status":"500"`. A metric filter pattern such as `{ $.sc-status >= 500 }` matches no events, and the metric stays at zero. This sample uses `{ $.sc-status = "5*" }`. You can check a pattern against sample events with `aws logs test-metric-filter` before you deploy it.
- **Parquet column names use underscores.** In the S3 copy, `distribution-tenant-id` becomes `distribution_tenant_id`, and all columns are strings. The Athena queries cast numbers where needed.
- **Keep CloudWatch Logs records small.** CloudFront includes 750 bytes of log delivery to CloudWatch Logs per request. This sample sends four fields, about 150 bytes per record. If you add fields, keep the record under 750 bytes.
- **Keep the Athena partition scheme simple.** This sample writes plain hourly folders (`YYYY/MM/DD/HH`) and projects one date-type partition, `dt`. Queries that filter on `dt` read only the matching hours.

### Limitations

- **Tenant alarms don't detect missing logs.** Periods without log data count as not breaching, so if log delivery stops, the tenant alarms stay in `OK`. A separate alarm covers this case: it goes to `ALARM` when the log group receives no log events for `noLogsAlarmMinutes` (60 by default with Option B). It can't tell stopped delivery from a distribution with no requests, so set the period longer than your quietest traffic gap.
- **Request paths are stored in the Amazon S3 copy.** The `cs-uri-stem` field supports the error-path report. If your URL paths can contain personal data, remove `cs-uri-stem` from the S3 fields in `lib/log-delivery.ts` and from the error-path query.

### Security considerations

- **Give account users least-privilege access to the logs and reports.** The logs show traffic and errors for every tenant. Grant on-call staff and finance analysts only the access they need: read access to the access log group, `s3:GetObject` on the `AWSLogs/` and `athena-results/` prefixes of the log bucket, and use of the Athena workgroup from the `AthenaWorkGroup` output.
- **Track changes to the monitoring resources.** Use AWS CloudTrail management events to see who changed or deleted Contributor Insights rules, metric filters, alarms, saved queries, or the bucket and log group policies, and use AWS CloudFormation drift detection to find changes made outside the stack.
- **What the logs contain.** The CloudWatch Logs copy has four fields per request: tenant ID, status code, bytes, and edge result type. The Amazon S3 copy adds the date and time, request path, time taken, edge location, and viewer country. Neither copy includes viewer IP addresses, cookies, or query strings. See [Limitations](#limitations) if your request paths can contain personal data.
- **How the stack protects the data.** The log bucket blocks public access, requires TLS, and uses server-side encryption with Amazon S3 managed keys. The bucket policy and the CloudWatch Logs resource policy let only the log delivery service write, only for delivery sources in this account and Region. The alarm topic requires TLS and is encrypted with an AWS Key Management Service (AWS KMS) key that only this stack's alarms can use. The demo origin function accepts only requests signed by CloudFront through origin access control.
- **Deploy with least-privilege, short-lived credentials.** The stack creates one AWS Identity and Access Management (IAM) role, for the demo origin function, limited to writing its own log group. Use temporary credentials for `cdk deploy`, and consider a scoped execution policy for the AWS CDK bootstrap instead of the default administrator access.

## Prerequisites

- An AWS account and the AWS Command Line Interface (AWS CLI) configured with credentials
- Node.js 22 or later
- The AWS Cloud Development Kit (AWS CDK) bootstrapped in `us-east-1` (`npx cdk bootstrap aws://ACCOUNT_ID/us-east-1`)
- For the demo: an Amazon Route 53 public hosted zone. The demo creates tenant domains under a subdomain of it (by default `tenant-a.tenants.<your zone>`).
- For your own distribution: a multi-tenant distribution (connection mode `tenant-only`) that doesn't already use standard logging (v2). CloudFront supports one log delivery source per distribution, so if your distribution already sends standard logs (v2), the deployment fails with `This ResourceId has already been used in another Delivery Source`. To check, run `aws logs describe-delivery-sources --region us-east-1` and look for your distribution's Amazon Resource Name (ARN). If one exists, this sample can't share it. Deleting that delivery source stops the standard logging (v2) it currently sends, so plan for that before you remove it.
- Multi-tenant distributions use pay-as-you-go pricing. CloudFront flat-rate pricing plans don't support multi-tenant distributions.
- For the demo: room for three more distribution tenants. CloudFront charges a monthly subscription fee once an account has more than 10 tenants, so check your current tenant count before you deploy the demo.
- Room for one more Amazon CloudWatch Logs resource policy in `us-east-1`, unless you deploy with `nearRealTime=false`. Each stack adds one to let log delivery write to its log group, and an account can have up to 10 per Region. To check, run `aws logs describe-resource-policies --region us-east-1`.

The stack deploys in `us-east-1`, where CloudFront publishes metrics and where you configure CloudFront log delivery.

## Deployment steps

Install the dependencies at the versions pinned in `package-lock.json`:

```bash
npm ci
```

### Option A: Deploy the demo

The demo creates a multi-tenant distribution with three tenants, a dedicated connection group, a wildcard certificate, DNS records, and an AWS Lambda origin. The demo distribution has no AWS WAF web ACL, because this sample focuses on monitoring. For production traffic, attach a web ACL to your distribution. The origin returns `500` for `/error` and `404` for `/missing`, and caches `/static/*`, so tenants can produce different traffic patterns.

```bash
npx cdk deploy \
  -c hostedZoneId=Z0123456789EXAMPLE \
  -c hostedZoneName=example.com
```

Send traffic for a few minutes. Each tenant gets a different pattern: tenant-a sends mostly cached content, tenant-b returns about 30% server errors, and tenant-c sends low volume:

```bash
node scripts/generate-traffic.mjs 10 \
  tenant-a.tenants.example.com tenant-b.tenants.example.com tenant-c.tenants.example.com
```

Logs reach CloudWatch Logs within a few minutes and Amazon S3 within about five minutes. Then open the `DashboardUrl` output. With the default settings, the tenant-b alarm moves to `ALARM`.

### Option B: Monitor your own multi-tenant distribution

List your tenants as `name=id` pairs:

```bash
node scripts/list-tenants.mjs E1234567890ABC
```

Deploy with your distribution ID and the tenant list. Choose the tenants to alarm on, and give the stack a name for this distribution:

```bash
npx cdk deploy \
  -c stackName=TenantsShopPlatform \
  -c distributionId=E1234567890ABC \
  -c tenants="shop-one=dt_abc123,shop-two=dt_def456" \
  -c alarmedTenants=shop-two \
  -c alarmEmail=you@example.com
```

Use a different `stackName` for each distribution you monitor. If you deploy with a stack name that's already in use, AWS CloudFormation updates that stack instead of creating a new one. If you deployed the demo first, use a different stack name so the demo isn't replaced. To run a second demo in the same account, pass both a different `stackName` and a different `tenantSubdomain`, because the tenant domains must be unique.

If you set `alarmEmail`, confirm the subscription email from Amazon Simple Notification Service (Amazon SNS). When you add tenants later, run the list script again and redeploy to update the dashboard table and the Athena queries. Tenants not in the list still appear in the rankings and reports, by ID.

### Settings

The required values (`distributionId` and `tenants`, or `hostedZoneId` and `hostedZoneName` for the demo) are described in the deployment options. The following settings are optional:

| Context value | Default | Effect |
|---|---|---|
| `stackName` | `PerTenantObservabilityStack` | Name of the stack and prefix for its resource names. Use a different name for each distribution you monitor (up to 40 characters: letters, numbers, and hyphens). |
| `nearRealTime` | `true` | Set to `false` to keep only the S3 delivery and Athena reports. This removes the CloudWatch Logs delivery, Contributor Insights rules, alarms, and dashboard. |
| `rankingRules` | `requests,errors,cacheMisses` | Contributor Insights rankings to create. Add `bytes` to rank by bytes served. Bytes per tenant are also in the Athena reports. |
| `alarmedTenants` | `tenant-b` (demo), none (Option B) | Comma-separated tenant names that get metrics and an alarm. Use `none` for no tenant alarms. Requires `nearRealTime=true`. |
| `errorRateThreshold` | `5` | 5xx error rate, in percent (greater than 0 and less than 100, decimals allowed), that triggers a tenant alarm |
| `alarmMinRequests` | `20` | Requests per 5 minutes a tenant needs before its error rate counts toward the alarm |
| `noLogsAlarmMinutes` | `0` (demo), `60` (Option B) | Minutes without any log events before the log delivery alarm goes to `ALARM` (0 to 1440). Use `0` for no alarm. The demo has it off because the distribution has no traffic until you run the traffic script. Requires `nearRealTime=true`. |
| `alarmEmail` | none | Email address for alarm notifications |
| `deleteLogsOnDestroy` | `true` (demo), `false` (Option B) | Whether deleting the stack also deletes the S3 bucket and its log files. With Option B, the bucket is kept by default so you keep the usage history. |
| `logRetentionDays` | `90` | Days to keep log files in Amazon S3. The Athena table covers the same range. Keep at least 62 days so the chargeback query sees the full previous month. |
| `tenantSubdomain` | `tenants` | Demo only. Subdomain of the hosted zone for tenant domains. |

The tenant names in `tenants` are written into the dashboard and the saved Athena queries when you deploy. This suits up to a few hundred tenants. With more, leave `tenants` out: the rankings and reports then show tenant IDs, and you can join the results with your own tenant list.

### Run the reports

In the Athena console, choose the workgroup from the `AthenaWorkGroup` output, open **Saved queries**, and run:

- **Daily usage per tenant (last 7 days and today):** requests, bytes served, 5xx error rate, cache hit rate, and p90 response time
- **Monthly data transfer per tenant (chargeback):** requests and gigabytes (10^9 bytes) served, for last month and this month to date
- **Top error paths per tenant (last 24 hours):** paths that returned 5xx, by tenant

## Running the tests

```bash
npm test
```

The tests check the synthesized template for each mode: the demo with default settings, reports only, and an existing distribution. Every `cdk synth` and `cdk deploy` also runs the [cdk-nag](https://github.com/cdklabs/cdk-nag) AWS Solutions checks. The findings this sample accepts are acknowledged in code, each with its reason, and a test fails if a new finding appears.

## Teardown

The resources in this sample incur charges while they run, including the demo's CloudFront distribution and the Contributor Insights rules, so delete the stack when you finish.

Delete the stack with the same context values you deployed with:

```bash
npx cdk destroy \
  -c hostedZoneId=Z0123456789EXAMPLE \
  -c hostedZoneName=example.com
```

For Option B, pass the same `-c stackName=... -c distributionId=...` instead. Deleting the stack removes the log delivery, log group, Contributor Insights rules, alarms, dashboard, AWS Glue database, and Athena workgroup.

- **Demo:** it also removes the distribution, tenants, connection group, certificate, DNS records, origin function, and the S3 bucket with its log files.
- **Option B:** your distribution and tenants aren't changed. The S3 bucket and its log files are kept, unless you deployed with `-c deleteLogsOnDestroy=true`. The bucket's lifecycle rule still removes each file after `logRetentionDays`, so copy any files you want to keep longer. Delete the bucket yourself when you no longer need it.

If you set `alarmEmail`, the stack also creates an AWS KMS key that encrypts the alarm topic. Deleting the stack schedules the key for deletion after 7 days.

Deleting a distribution can take several minutes, because CloudFront first disables it.

Two items remain after the stack is deleted. Remove them if you no longer need them:

- **Certificate validation record (demo only).** The demo validates its certificate with a DNS record named `_<token>.tenants.<your zone>` that points to `acm-validations.aws`. AWS CloudFormation doesn't delete this record. Delete it from the hosted zone.
- **Log group of the S3 cleanup function (when the bucket is deleted).** The AWS CDK adds a function that empties the S3 bucket during deletion. Lambda creates its log group, `/aws/lambda/<stack name prefix>-CustomS3AutoDeleteObject-<suffix>`, when the function runs. Delete it in the CloudWatch console or with `aws logs delete-log-group`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This sample is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
