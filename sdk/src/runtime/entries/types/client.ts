import "./shared";

export interface ClientNavigationOptions {
  onNavigate?: () => void;
  scrollToTop?: boolean;
  scrollBehavior?: "auto" | "smooth" | "instant";
}

declare global {
  interface Window {
    __RWSDK_STABLE__?: boolean;
  }

  interface WindowEventMap {
    "rwsdk:render-committed": CustomEvent<{
      generation: number;
      url: string;
    }>;
    "rwsdk:stable": CustomEvent<{ generation: number }>;
  }
}
