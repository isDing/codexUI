import { useEffect } from "react";
import type { HttpBase } from "./http";
import type { AuthState } from "./types";

export const useActivityRefresh = (
  api: HttpBase,
  auth: AuthState,
  onActivityExpiry: (expiresAt: number) => void,
  onAuthChange: (value: AuthState) => void,
): void => {
  useEffect(() => {
    let lastSent = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastSent < 60_000) return;
      lastSent = now;
      void api.activity().then(({ expiresAt }) => onActivityExpiry(expiresAt)).catch(() => undefined);
    };
    const events: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart"];
    events.forEach((event) => window.addEventListener(event, onActivity, { passive: true }));
    const expiry = window.setInterval(() => {
      if (auth.expiresAt && Date.now() >= auth.expiresAt) onAuthChange({ authenticated: false });
    }, 30_000);
    return () => {
      events.forEach((event) => window.removeEventListener(event, onActivity));
      clearInterval(expiry);
    };
  }, [api, auth, onActivityExpiry, onAuthChange]);
};
