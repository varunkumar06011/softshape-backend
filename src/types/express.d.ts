declare namespace Express {
  interface Request {
    user?: {
      userId: string;
      email?: string;
      role: string;
      restaurantId: string;
      slug: string;
      iat?: number;
      exp?: number;
    };
  }
}
