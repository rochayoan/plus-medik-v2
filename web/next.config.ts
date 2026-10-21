import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // El core (../dist) vive fuera de web/: la raíz del workspace es el repo completo.
  turbopack: { root: fileURLToPath(new URL("..", import.meta.url)) },
  serverExternalPackages: ["@react-pdf/renderer"],
  // El logo opcional se lee del disco al generar el PDF: debe viajar con esa función.
  outputFileTracingIncludes: { "/api/quotes/[id]/pdf": ["./public/brand/**/*"] },
  poweredByHeader: false
};

export default nextConfig;
