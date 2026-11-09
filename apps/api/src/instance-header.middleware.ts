import type { NextFunction, Request, Response } from 'express';

export function instanceHeader(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  res.setHeader('X-Instance', process.env.INSTANCE_ID ?? 'unknown');
  next();
}
