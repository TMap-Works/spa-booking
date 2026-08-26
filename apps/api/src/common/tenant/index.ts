export { CurrentTenant } from './current-tenant.decorator';
export {
  describePublicTenantRequest,
  publicBaseHost,
  PUBLIC_ROUTE_SEGMENT,
  readSubdomainSlug,
  type PublicTenantDesignation,
} from './public-tenant-request';
export {
  PUBLIC_TENANT_RESOLVER,
  type PublicTenantResolver,
  type PublicTenantResolverProvider,
} from './public-tenant.resolver';
export {
  getTenantId,
  hasTenantScope,
  requireTenantId,
  runInTenantScope,
  runWithTenant,
  setRequestTenantId,
} from './tenant-context';
export {
  InvalidTenantIdError,
  MissingTenantContextError,
  TenantAlreadyResolvedError,
  TenantContextError,
  TenantScopeNotOpenError,
} from './tenant-context.errors';
export { TenantContextModule } from './tenant-context.module';
export { TenantContextService } from './tenant-context.service';
export { TenantScopeMiddleware } from './tenant-scope.middleware';
