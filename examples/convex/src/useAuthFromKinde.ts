import { useKindeAuth } from "@kinde-oss/kinde-auth-react";
import { useCallback, useMemo } from "react";

// ConvexProviderWithAuth calls this for a token. It returns the Kinde access token, which carries
// org_code and permissions, instead of the ID token. Kinde refreshes an expired token itself, so
// Convex's forceRefreshToken flag needs no handling here.
export function useAuthFromKinde() {
  const { isLoading, isAuthenticated, getAccessToken } = useKindeAuth();
  const fetchAccessToken = useCallback(async () => {
    try {
      return (await getAccessToken()) ?? null;
    } catch {
      return null;
    }
  }, [getAccessToken]);
  return useMemo(() => ({ isLoading, isAuthenticated, fetchAccessToken }), [isLoading, isAuthenticated, fetchAccessToken]);
}
