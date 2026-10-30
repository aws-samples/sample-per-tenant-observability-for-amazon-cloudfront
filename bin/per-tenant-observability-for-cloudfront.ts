#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { parseContext } from '../lib/context';
import { PerTenantObservabilityStack } from '../lib/per-tenant-observability-stack';

const app = new cdk.App();
// cdk-nag checks every synth; accepted findings are acknowledged in code with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
const { stackName, props } = parseContext((key) => app.node.tryGetContext(key));

// CloudFront publishes metrics and accepts log delivery sources in us-east-1.
new PerTenantObservabilityStack(app, stackName, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  ...props,
});
