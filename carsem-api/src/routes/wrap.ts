import type { NextFunction, Request, Response } from "express";

/** Express 4 does not route rejected promises to the error handler; this does. */
export const wrap = (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next); };
