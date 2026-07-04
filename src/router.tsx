import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  // Defaults tuned for a data-heavy SaaS:
  // - staleTime 30s: navegação entre abas não refaz fetch (TBT ↓, requests ↓)
  // - gcTime 5min: cache sobrevive ida/volta sem re-render vazio
  // - refetchOnWindowFocus false: evita spikes ao voltar a aba
  // - retry 1: falhas 5xx tentam 1x; 4xx idempotentes falham rápido
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
      mutations: { retry: 0 },
    },
  });


  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
