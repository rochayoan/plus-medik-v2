import type { MetadataRoute } from "next";

// Instalable en el celular: se abre como app, directo en el cotizador.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PlusMedik Cotizador",
    short_name: "Cotizador",
    start_url: "/cotizar",
    display: "standalone",
    background_color: "#f5f8fa",
    theme_color: "#0f766e",
    lang: "es",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }]
  };
}
