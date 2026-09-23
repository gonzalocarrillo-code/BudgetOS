import { DomainError, httpStatus } from "@budget/domain";
import { Catch, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";

@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: DomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status: (code: number) => { send: (body: unknown) => void };
    }>();
    response.status(httpStatus[error.code]).send({
      code: error.code,
      message: error.message,
      details: error.details ?? null,
    });
  }
}
