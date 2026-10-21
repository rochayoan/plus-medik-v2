import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refresca la sesión de Supabase en cada navegación y manda al login a quien no la tenga.
// Comprobación optimista: la autorización real está en cada página/ruta (getSession) y en la RLS.
const PUBLIC_PATHS = ["/login"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      }
    }
  });

  const { data } = await supabase.auth.getClaims();
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

  if (!data?.claims && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  if (data?.claims && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/cotizar";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

// Las rutas /api no pasan por aquí: validan la sesión ellas mismas (y aceptan Bearer), sin pagar dos veces la verificación
// en cada consulta (p. ej. el sondeo del análisis de foto).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|brand/|api/).*)"]
};
