"use client";

import { get, set } from "idb-keyval";
import { useCallback, useEffect, useState } from "react";
import type { CatalogPayload } from "@/lib/catalog-types";

interface CatalogState {
  catalog: CatalogPayload | null;
  error: string | null;
}

// Muestra al instante el catálogo guardado en IndexedDB y lo revalida en segundo plano (304 si no cambió).
export function useCatalog(userId: string) {
  const [state, setState] = useState<CatalogState>({ catalog: null, error: null });

  const load = useCallback(async () => {
    const key = `pm:catalog:${userId}`;
    let cached: CatalogPayload | undefined;
    try {
      cached = await get<CatalogPayload>(key);
    } catch {
      // IndexedDB no disponible (modo privado): se descarga siempre.
    }
    if (cached?.studies) setState({ catalog: cached, error: null });

    try {
      const response = await fetch("/api/catalog", {
        cache: "no-store",
        headers: cached?.version ? { "If-None-Match": `"${cached.version}"` } : {}
      });
      if (response.status === 304) return;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const fresh = (await response.json()) as CatalogPayload;
      setState({ catalog: fresh, error: null });
      try {
        await set(key, fresh);
      } catch {
        // sin persistencia: no afecta el uso
      }
    } catch {
      if (!cached) setState({ catalog: null, error: "No se pudo cargar el catálogo. Revisa tu conexión e intenta de nuevo." });
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, reload: load };
}
