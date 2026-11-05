#!/usr/bin/env node
// Prints the tenants of a multi-tenant distribution as name=id pairs, ready to pass
// to the stack with -c tenants=...
//
// Usage: node scripts/list-tenants.mjs <distribution-id>

import { CloudFrontClient, ListDistributionTenantsCommand } from '@aws-sdk/client-cloudfront';

const distributionId = process.argv[2];
if (!distributionId) {
  console.error('Usage: node scripts/list-tenants.mjs <distribution-id>');
  process.exit(1);
}

const client = new CloudFrontClient({ region: 'us-east-1' });
const pairs = [];
let marker;
do {
  const page = await client.send(new ListDistributionTenantsCommand({
    AssociationFilter: { DistributionId: distributionId },
    Marker: marker,
  }));
  for (const tenant of page.DistributionTenantList ?? []) pairs.push(`${tenant.Name}=${tenant.Id}`);
  marker = page.NextMarker;
} while (marker);

console.log(pairs.join(','));
