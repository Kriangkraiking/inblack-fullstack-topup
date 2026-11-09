import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { PROBLEM_CONTENT_TYPE, renderProblem, toProblem } from './problem.js';

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const problem = toProblem(exception);
    if (problem.status >= 500) {
      this.logger.error(exception instanceof Error ? exception.message : String(exception));
    }
    const response = host.switchToHttp().getResponse<Response>();
    response
      .status(problem.status)
      .type(PROBLEM_CONTENT_TYPE)
      .send(renderProblem(problem));
  }
}
