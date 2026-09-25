import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { Permission } from "../../common/permission.decorator.js";
import { Tenant, type AuthContext } from "../../common/tenant.js";
import { ClosuresService } from "./closures.service.js";
import { CloseDto, RestateDto } from "./dto.js";

/** Period closures (spec §15, §17 `closures`). Entity routes take the workspace from X-Workspace-Id. */
@Controller()
export class ClosuresController {
  constructor(@Inject(ClosuresService) private readonly closures: ClosuresService) {}

  @Get("workspaces/:ws/closures")
  @Permission("envelope.read")
  list(@Tenant() auth: AuthContext) {
    return this.closures.list(auth);
  }

  @Post("workspaces/:ws/closures")
  @Permission("closure.close")
  close(@Tenant() auth: AuthContext, @Body() body: CloseDto) {
    return this.closures.close(auth, body);
  }

  @Post("closures/:id/restate")
  @Permission("closure.restate")
  restate(@Tenant() auth: AuthContext, @Param("id") id: string, @Body() body: RestateDto) {
    return this.closures.restate(auth, id, body);
  }

  @Get("closures/:id/report")
  @Permission("envelope.read")
  report(@Tenant() auth: AuthContext, @Param("id") id: string) {
    return this.closures.report(auth, id);
  }
}
