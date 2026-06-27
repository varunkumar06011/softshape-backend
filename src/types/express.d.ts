declare namespace Express {
  interface Request {
    user?: {
      id?: string;
      userId?: string;
      email?: string;
      name?: string;
      role: string;
      restaurantId: string;
      activeRestaurantId?: string;
      slug?: string;
      iat?: number;
      exp?: number;
    };
  }
}
