import * as cdk from 'aws-cdk-lib/core';
import { IConstruct } from 'constructs';

/**
 * Checkov checks that don't apply to this sample, with the reason for each. The reasons are
 * written into the template metadata, so scanners and reviewers see them next to the resource.
 */
const SKIPS: Record<string, { id: string; comment: string }[]> = {
  'AWS::CertificateManager::Certificate': [
    { id: 'CKV2_AWS_71', comment: 'Demo only. Distribution tenants inherit one wildcard certificate from the multi-tenant distribution, which is the documented pattern for tenant subdomains.' },
  ],
  'AWS::Lambda::Function': [
    { id: 'CKV_AWS_115', comment: 'Demo origin and the AWS CDK bucket cleanup function. Reserved concurrency can fail deployment in accounts with a low concurrency quota.' },
    { id: 'CKV_AWS_116', comment: 'Invoked synchronously (by CloudFront or by CloudFormation), so there is no asynchronous event to send to a dead-letter queue.' },
    { id: 'CKV_AWS_117', comment: 'Accesses no private resources, so it does not need to run in a VPC.' },
  ],
  'AWS::Logs::LogGroup': [
    { id: 'CKV_AWS_158', comment: 'CloudWatch Logs encrypts log data at rest by default. The logs contain request metadata, not secrets.' },
  ],
  'AWS::S3::Bucket': [
    { id: 'CKV_AWS_18', comment: 'This bucket stores CloudFront access logs; logging access to it would add a second log bucket for no benefit in this sample.' },
    { id: 'CKV_AWS_21', comment: 'Log files expire by a lifecycle rule. Versioning would keep deleted copies and add storage cost.' },
  ],
  'AWS::CloudFront::Distribution': [
    { id: 'CKV_AWS_68', comment: 'Demo distribution for a monitoring sample. Add an AWS WAF web ACL for production use, as the README notes.' },
    { id: 'CKV_AWS_86', comment: 'Access logging uses standard logging (v2) through AWS::Logs::Delivery resources. The check looks only for the legacy Logging property, which multi-tenant distributions do not support.' },
  ],
};

export class ScannerSuppressions implements cdk.IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof cdk.CfnResource)) return;
    const skips = SKIPS[node.cfnResourceType];
    if (skips) node.addMetadata('checkov', { skip: skips });
  }
}
