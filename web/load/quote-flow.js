// Prueba de carga del portal (k6). NUNCA contra producción: usar un deploy de preview conectado a un Supabase de staging/branch,
// con ANALYZER_MODE=mock (las fotos no llaman a modelos reales) y PHOTO_DAILY_LIMIT alto.
//
//   k6 run -e BASE_URL=https://<preview>.vercel.app -e SUPABASE_URL=https://<staging>.supabase.co \
//          -e SUPABASE_KEY=<clave publicable> -e USERS_FILE=./load/users.json web/load/quote-flow.js
//
// users.json: [{ "email": "...", "password": "..." }, ...] (lo genera web/load/seed-load-users.ts).
import { check, group, sleep } from "k6";
import http from "k6/http";
import { SharedArray } from "k6/data";

const BASE_URL = __ENV.BASE_URL;
const SUPABASE_URL = __ENV.SUPABASE_URL;
const SUPABASE_KEY = __ENV.SUPABASE_KEY;
const users = new SharedArray("users", () => JSON.parse(open(__ENV.USERS_FILE || "./users.json")));
const photo = __ENV.PHOTO_FILE ? open(__ENV.PHOTO_FILE, "b") : null;

export const options = {
  scenarios: {
    // 50 cotizando a la vez, con pico de 100.
    cotizadores: {
      executor: "ramping-vus",
      exec: "quoteFlow",
      startVUs: 0,
      stages: [
        { duration: "1m", target: 50 },
        { duration: "3m", target: 50 },
        { duration: "1m", target: 100 },
        { duration: "1m", target: 0 }
      ]
    },
    // 20 usuarios subiendo fotos al mismo tiempo (análisis simulado).
    fotos: { executor: "constant-vus", exec: "photoFlow", vus: photo ? 20 : 0, duration: "4m", startTime: "30s" }
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{name:catalog_304}": ["p(95)<150"],
    "http_req_duration{name:catalog_full}": ["p(95)<800"],
    "http_req_duration{name:create_quote}": ["p(95)<400"],
    "http_req_duration{name:pdf}": ["p(95)<1500"],
    "http_req_duration{name:photo_status}": ["p(95)<300"],
    checks: ["rate>0.99"]
  }
};

// Estado por usuario virtual (cada VU usa una cuenta).
let session = null;
let catalog = null;
let etag = null;

function login() {
  const user = users[(__VU - 1) % users.length];
  const response = http.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, JSON.stringify(user), {
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    tags: { name: "login" }
  });
  check(response, { "login 200": (r) => r.status === 200 });
  session = { token: response.json("access_token"), expiresAt: Date.now() + (response.json("expires_in") - 60) * 1000 };
}

function auth() {
  if (!session || Date.now() > session.expiresAt) login();
  return { Authorization: `Bearer ${session.token}` };
}

function loadCatalog() {
  const headers = auth();
  if (etag) headers["If-None-Match"] = etag;
  const response = http.get(`${BASE_URL}/api/catalog`, { headers, tags: { name: etag ? "catalog_304" : "catalog_full" } });
  check(response, { "catálogo 200/304": (r) => r.status === 200 || r.status === 304 });
  if (response.status === 200) {
    catalog = response.json("studies").map((study) => study.id);
    etag = response.headers.Etag || response.headers.ETag;
  }
}

function pick(count) {
  const chosen = new Set();
  while (chosen.size < Math.min(count, catalog.length)) chosen.add(catalog[Math.floor(Math.random() * catalog.length)]);
  return [...chosen];
}

export function quoteFlow() {
  group("abrir cotizador", loadCatalog);
  if (!catalog || catalog.length === 0) return;
  // Tiempo real de armado: buscar en el navegador no genera tráfico al servidor.
  sleep(5 + Math.random() * 15);

  const quote = http.post(
    `${SUPABASE_URL}/rest/v1/rpc/create_quote`,
    JSON.stringify({ p_lab_test_ids: pick(3 + Math.floor(Math.random() * 6)), p_patient_name: "Paciente de prueba", p_source: "manual" }),
    { headers: { ...auth(), apikey: SUPABASE_KEY, "Content-Type": "application/json" }, tags: { name: "create_quote" } }
  );
  check(quote, { "cotización creada": (r) => r.status === 200 && Boolean(r.json("id")) });

  if (quote.status === 200 && Math.random() < 0.5) {
    const pdf = http.get(`${BASE_URL}/api/quotes/${quote.json("id")}/pdf`, { headers: auth(), tags: { name: "pdf" } });
    check(pdf, { "pdf 200": (r) => r.status === 200 && String(r.headers["Content-Type"]).includes("pdf") });
  }
  sleep(10 + Math.random() * 20);
}

export function photoFlow() {
  if (!photo) return;
  const created = http.post(`${BASE_URL}/api/photo-jobs`, JSON.stringify({ mimeType: "image/jpeg" }), {
    headers: { ...auth(), "Content-Type": "application/json" },
    tags: { name: "photo_create" }
  });
  if (!check(created, { "foto reservada": (r) => r.status === 200 })) {
    sleep(5);
    return;
  }
  const { jobId, path, token } = created.json();
  const upload = http.put(`${SUPABASE_URL}/storage/v1/object/upload/sign/quote-photos/${path}?token=${token}`, photo, {
    headers: { "Content-Type": "image/jpeg", "x-upsert": "false" },
    tags: { name: "photo_upload" }
  });
  check(upload, { "foto subida": (r) => r.status === 200 });
  const started = http.post(`${BASE_URL}/api/photo-jobs/${jobId}/start`, null, { headers: auth(), tags: { name: "photo_start" } });
  check(started, { "análisis iniciado": (r) => r.status === 202 });

  let status = "running";
  for (let attempt = 0; attempt < 60 && status === "running"; attempt++) {
    sleep(2);
    const poll = http.get(`${BASE_URL}/api/photo-jobs/${jobId}`, { headers: auth(), tags: { name: "photo_status" } });
    status = poll.status === 200 ? poll.json("status") : status;
  }
  check(status, { "foto analizada": (value) => value === "done" });
  sleep(10 + Math.random() * 10);
}
