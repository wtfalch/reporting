import { type ResourceModule, defineResourceCatalogue } from '@wtfalch/authz';

// Scaffold catalogue, carried over unchanged from package-template's toy
// domain (issue #42, docs/plans/collector.md slice 2). `@wtfalch/authz`'s
// own id schema rejects any permission whose action suffix is exactly
// "write" (reserved, alongside "admin"/"manage"/"read-all") -- see
// resourcePermissionIdSchema in the authz package -- so `reportings:create`
// names this toy's one write operation. Slice 3 replaces this catalogue
// with the real collector's permissions (event/analytics read and write,
// scoped per docs/plans/collector.md point 5).
export const policyModule = {
  namespace: 'reportings',
  permissions: [
    {
      id: 'reportings:read',
      label: 'Read reportings',
      description: "Read an organisation's reportings.",
      resourceType: 'reportings.reporting',
      effect: 'read',
      scopes: ['organisation'],
      boundaries: ['organisation'],
      relations: ['any'],
      tenantKinds: ['customer'],
      offered: false,
      assignable: true,
      sensitive: false,
      survives: ['read_only'],
      support: 'read',
    },
    {
      id: 'reportings:create',
      label: 'Create reportings',
      description: 'Create a reporting in an organisation.',
      resourceType: 'reportings.reporting',
      effect: 'write',
      scopes: ['organisation'],
      boundaries: ['organisation'],
      relations: ['any'],
      tenantKinds: ['customer'],
      offered: true,
      assignable: true,
      sensitive: false,
      survives: [],
      support: 'never',
    },
  ],
} as const satisfies ResourceModule;
export const catalogue = defineResourceCatalogue([policyModule]);
export type Permission = (typeof policyModule.permissions)[number]['id'];
