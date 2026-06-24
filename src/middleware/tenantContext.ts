import { Request, Response, NextFunction } from "express";
import { tenantStorage } from "../lib/prisma";

export function withTenantContext(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user?.restaurantId) {
    return next();
  }
  tenantStorage.run({ restaurantId: user.restaurantId }, next);
}
