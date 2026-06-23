declare namespace Express {
  interface Request {
    user?: {
      id?: string;
      userId?: string;
      email?: string;
      name?: string;
      role: string;
      restaurantId: string;
      slug?: string;
      iat?: number;
      exp?: number;
    };
  }
}
