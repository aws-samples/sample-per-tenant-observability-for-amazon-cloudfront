import * as cdk from 'aws-cdk-lib/core';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface DemoTenantsProps {
  /** Public hosted zone that hosts the demo tenant domains. */
  readonly hostedZone: route53.IHostedZone;
  /** Subdomain of the hosted zone used for tenant domains, for example "tenants". */
  readonly tenantSubdomain: string;
  /** Tenant names. Each tenant gets the domain <name>.<tenantSubdomain>.<zone>. */
  readonly tenantNames: string[];
}

/**
 * A multi-tenant distribution with demo tenants, so the observability stack has
 * traffic to work with. In your own environment, replace this with your existing
 * multi-tenant distribution.
 */
export class DemoTenants extends Construct {
  public readonly distribution: cloudfront.CfnDistribution;
  public readonly distributionArn: string;
  public readonly tenants: cloudfront.CfnDistributionTenant[] = [];
  public readonly tenantDomains: string[] = [];

  constructor(scope: Construct, id: string, props: DemoTenantsProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const parentDomain = `${props.tenantSubdomain}.${props.hostedZone.zoneName}`;

    // One wildcard certificate on the multi-tenant distribution; tenants inherit it.
    const certificate = new acm.Certificate(this, 'WildcardCertificate', {
      domainName: `*.${parentDomain}`,
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
    });

    // An explicit log group, so deleting the stack also deletes the function's logs, and a
    // role that can write only to that log group.
    const originLogs = new logs.LogGroup(this, 'OriginFunctionLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const originRole = new iam.Role(this, 'OriginFunctionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        WriteLogs: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [originLogs.logGroupArn],
          })],
        }),
      },
    });
    // Demo origin. The response depends on the path, so tenants can produce
    // different traffic patterns: /static/* is cacheable, /error returns 500,
    // /missing returns 404, and anything else returns an uncached 200.
    const originFunction = new lambda.Function(this, 'OriginFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
      role: originRole,
      logGroup: originLogs,
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  const path = event.rawPath || '/';
  if (path === '/error') return { statusCode: 500, body: 'error' };
  if (path === '/missing') return { statusCode: 404, body: 'not found' };
  const cacheable = path.startsWith('/static/');
  return {
    statusCode: 200,
    headers: { 'cache-control': cacheable ? 'max-age=300' : 'no-store' },
    body: 'ok ' + path,
  };
};`),
    });
    const functionUrl = originFunction.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    const originAccessControl = new cloudfront.CfnOriginAccessControl(this, 'OriginAccessControl', {
      originAccessControlConfig: {
        name: `${stack.stackName}-origin`,
        originAccessControlOriginType: 'lambda',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    this.distribution = new cloudfront.CfnDistribution(this, 'MultiTenantDistribution', {
      distributionConfig: {
        enabled: true,
        comment: 'Per-tenant observability demo (multi-tenant)',
        connectionMode: 'tenant-only',
        httpVersion: 'http2and3',
        origins: [{
          id: 'demo-origin',
          domainName: cdk.Fn.select(2, cdk.Fn.split('/', functionUrl.url)),
          originAccessControlId: originAccessControl.attrId,
          customOriginConfig: {
            originProtocolPolicy: 'https-only',
            originSslProtocols: ['TLSv1.2'],
          },
        }],
        defaultCacheBehavior: {
          targetOriginId: 'demo-origin',
          viewerProtocolPolicy: 'redirect-to-https',
          allowedMethods: ['GET', 'HEAD'],
          cachePolicyId: cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
          originRequestPolicyId: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId,
        },
        cacheBehaviors: [{
          pathPattern: '/static/*',
          targetOriginId: 'demo-origin',
          viewerProtocolPolicy: 'redirect-to-https',
          allowedMethods: ['GET', 'HEAD'],
          cachePolicyId: cloudfront.CachePolicy.CACHING_OPTIMIZED.cachePolicyId,
        }],
        viewerCertificate: {
          acmCertificateArn: certificate.certificateArn,
          sslSupportMethod: 'sni-only',
          minimumProtocolVersion: 'TLSv1.2_2021',
        },
      },
    });
    // Accepted cdk-nag findings for the demo distribution (see the README).
    for (const [id, reason] of [
      ['AwsSolutions-CFR1', 'Demo distribution with no geographic requirement.'],
      ['AwsSolutions-CFR2', 'Demo distribution for a monitoring sample. The README tells readers to attach an AWS WAF web ACL for production traffic.'],
      ['AwsSolutions-CFR3', 'Access logging uses standard logging (v2) through AWS::Logs::Delivery resources. The rule checks only the legacy Logging property, which multi-tenant distributions do not support.'],
    ]) cdk.Validations.of(this.distribution).acknowledge({ id, reason });
    this.distributionArn = `arn:${stack.partition}:cloudfront::${stack.account}:distribution/${this.distribution.ref}`;

    // Function URLs with OAC need both permissions, scoped to this distribution and,
    // for InvokeFunction, to calls made through the function URL.
    new lambda.CfnPermission(this, 'AllowCloudFrontInvokeUrl', {
      functionName: originFunction.functionName,
      action: 'lambda:InvokeFunctionUrl',
      principal: 'cloudfront.amazonaws.com',
      sourceArn: this.distributionArn,
      functionUrlAuthType: 'AWS_IAM',
    });
    new lambda.CfnPermission(this, 'AllowCloudFrontInvoke', {
      functionName: originFunction.functionName,
      action: 'lambda:InvokeFunction',
      principal: 'cloudfront.amazonaws.com',
      sourceArn: this.distributionArn,
      invokedViaFunctionUrl: true,
    });

    // A dedicated connection group, so deleting the stack removes it too.
    const connectionGroup = new cloudfront.CfnConnectionGroup(this, 'ConnectionGroup', {
      name: `${stack.stackName}-tenants`,
      enabled: true,
      ipv6Enabled: true,
    });

    for (const name of props.tenantNames) {
      const domain = `${name}.${parentDomain}`;
      const tenant = new cloudfront.CfnDistributionTenant(this, `Tenant-${name}`, {
        name,
        distributionId: this.distribution.ref,
        connectionGroupId: connectionGroup.attrId,
        domains: [domain],
        enabled: true,
      });
      new route53.CnameRecord(this, `TenantRecord-${name}`, {
        zone: props.hostedZone,
        recordName: domain,
        domainName: connectionGroup.attrRoutingEndpoint,
        ttl: cdk.Duration.minutes(5),
      });
      this.tenants.push(tenant);
      this.tenantDomains.push(domain);
    }
  }
}
