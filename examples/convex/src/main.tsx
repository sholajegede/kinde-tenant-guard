import { KindeProvider } from "@kinde-oss/kinde-auth-react";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useAuthFromKinde } from "./useAuthFromKinde";
import "./styles.css";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <KindeProvider
      clientId={import.meta.env.VITE_KINDE_CLIENT_ID}
      domain={import.meta.env.VITE_KINDE_DOMAIN}
      audience={import.meta.env.VITE_KINDE_AUDIENCE}
      redirectUri={window.location.origin}
      logoutUri={window.location.origin}
      // localhost has no Kinde custom domain, so the refresh token is kept in the browser in development.
      useInsecureForRefreshToken={import.meta.env.DEV}
    >
      <ConvexProviderWithAuth client={convex} useAuth={useAuthFromKinde}>
        <App />
      </ConvexProviderWithAuth>
    </KindeProvider>
  </StrictMode>,
);
