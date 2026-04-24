export type AuthenticatedUser = {
  id: string;
  email?: string | null;
};

export type AuthenticatedRequest = {
  headers?: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
};
