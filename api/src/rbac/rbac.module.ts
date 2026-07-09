import { Global, Module } from '@nestjs/common';
import { RbacDataService } from './rbac-data.service';
import { ScopeResolverService } from './scope-resolver.service';
import { ScopeEnforcerService } from './scope-enforcer.service';

@Global()
@Module({
  providers: [RbacDataService, ScopeResolverService, ScopeEnforcerService],
  exports: [RbacDataService, ScopeResolverService, ScopeEnforcerService],
})
export class RbacModule {}
