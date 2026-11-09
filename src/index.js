const CODE = /^[0-9abcdefghjkmnpqrstvwxyz]{16}$/;
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const MAX_BYTES = 400000;

let schemaReady;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function newId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

function acceptable(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value.version === 1 || value.version === 2) &&
    Array.isArray(value.medicines) &&
    Array.isArray(value.doses) &&
    Array.isArray(value.ingredients)
  );
}

async function readPayload(request) {
  const text = await request.text();
  if (text.length > MAX_BYTES) return { error: json({ error: "That log is too large." }, 413) };
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { error: json({ error: "Send the log as JSON." }, 400) };
  }
  if (!acceptable(value)) return { error: json({ error: "That file is not a medicine log." }, 400) };
  return { text };
}

async function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.prepare(
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ).run().catch((err) => {
      schemaReady = undefined;
      throw err;
    });
  }
  await schemaReady;
}

async function handleApi(request, env, url) {
  if (!env.DB) return json({ error: "Shared logs are not available." }, 503);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "sessions" || parts.length > 3) return json({ error: "Not found." }, 404);
  await ensureSchema(env.DB);
  const id = parts[2] || "";

  if (request.method === "POST" && !id) {
    const payload = await readPayload(request);
    if (payload.error) return payload.error;
    const created = newId();
    await env.DB.prepare(
      "INSERT INTO sessions (id, payload, updated_at) VALUES (?, ?, ?)"
    ).bind(created, payload.text, new Date().toISOString()).run();
    return json({ id: created }, 201);
  }

  if (!CODE.test(id)) return json({ error: "Not found." }, 404);

  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT payload FROM sessions WHERE id = ?").bind(id).first();
    if (!row) return json({ error: "Not found." }, 404);
    return new Response(row.payload, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }

  if (request.method === "PUT") {
    const payload = await readPayload(request);
    if (payload.error) return payload.error;
    const result = await env.DB.prepare(
      "UPDATE sessions SET payload = ?, updated_at = ? WHERE id = ?"
    ).bind(payload.text, new Date().toISOString(), id).run();
    if (!result.meta || result.meta.changes < 1) return json({ error: "Not found." }, 404);
    return new Response(null, { status: 204 });
  }

  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/sessions" || url.pathname.startsWith("/api/sessions/")) {
      return handleApi(request, env, url);
    }
    return env.ASSETS.fetch(request);
  }
};
