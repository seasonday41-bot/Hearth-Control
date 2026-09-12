// ==============================================================================
// Supabase Edge Function Stub: create-hearth-task
// Server-side entry point for external clients (e.g. ChatGPT / Custom GPT action)
//
// FLOW:
// 1. External client sends POST with pairing secret header 'x-hearth-pairing-secret'
// 2. Function computes SHA-256 hash of secret and queries hearth_devices
// 3. Verifies device exists, bridge_enabled = true, and resolves (owner_id, device_id)
// 4. Validates payload: prompt (required, <= 64 KiB), title (optional), requestId (optional)
// 5. Accepts only the documented task fields; all execution-boundary fields are rejected
// 6. Inserts pending task into hearth_tasks using service_role Supabase client
// 7. Returns task ID and pending status to caller
// ==============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const MAX_PROMPT_BYTES = 65536; // 64 KiB
const MAX_REQUEST_BYTES = 70000;
const MAX_TITLE_CHARS = 200;
const MAX_REQUEST_ID_CHARS = 100;
const ALLOWED_PAYLOAD_KEYS = new Set(['prompt', 'title', 'requestId']);
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hearth-pairing-secret',
};

const response = (body: Record<string, unknown>, status: number) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

// Errors intentionally do not disclose authentication, device, or database details.
const invalidRequest = () => response({ error: 'Invalid request.' }, 400);
const unauthorized = () => response({ error: 'Unauthorized.' }, 401);
const unavailable = () => response({ error: 'Service unavailable.' }, 503);

async function sha256(str: string): Promise<string> {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: JSON_HEADERS,
    });
  }

  if (req.method !== 'POST') {
    return response({ error: 'Method not allowed.' }, 405);
  }

  try {
    const pairingSecret = req.headers.get('x-hearth-pairing-secret') || '';
    if (!pairingSecret || !pairingSecret.startsWith('hearth_sec_')) {
      return unauthorized();
    }

    const declaredLength = Number(req.headers.get('content-length') || 0);
    if (!Number.isFinite(declaredLength) || declaredLength > MAX_REQUEST_BYTES) {
      return invalidRequest();
    }

    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).length > MAX_REQUEST_BYTES) {
      return invalidRequest();
    }

    const payload = JSON.parse(rawBody);
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
      return invalidRequest();
    }

    // Strict allowlist: a remote caller may describe work, but cannot choose
    // a workspace, executor, command, permission level, or any other boundary.
    for (const key of Object.keys(payload)) {
      if (!ALLOWED_PAYLOAD_KEYS.has(key)) return invalidRequest();
    }

    const { prompt, title, requestId } = payload;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return invalidRequest();
    }

    const promptBytes = new TextEncoder().encode(prompt).length;
    if (promptBytes > MAX_PROMPT_BYTES) {
      return invalidRequest();
    }
    if (title !== undefined && (typeof title !== 'string' || title.length > MAX_TITLE_CHARS)) {
      return invalidRequest();
    }
    if (requestId !== undefined && (
      typeof requestId !== 'string' ||
      !requestId.trim() ||
      requestId.length > MAX_REQUEST_ID_CHARS
    )) {
      return invalidRequest();
    }

    // Initialize server-side Supabase client using environment service role key
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!supabaseUrl || !supabaseServiceKey) {
      return unavailable();
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Compute pairing hash and verify against hearth_devices
    const hash = await sha256(pairingSecret);
    const { data: device, error: deviceError } = await supabase
      .from('hearth_devices')
      .select('id, owner_id, device_id, bridge_enabled')
      .eq('pairing_hash', hash)
      .maybeSingle();

    if (deviceError || !device) {
      return unauthorized();
    }

    if (!device.bridge_enabled) {
      return unauthorized();
    }

    // Check idempotency if requestId provided
    if (requestId && typeof requestId === 'string') {
      const { data: existing } = await supabase
        .from('hearth_tasks')
        .select('id, status, created_at')
        .eq('owner_id', device.owner_id)
        .eq('device_id', device.device_id)
        .eq('request_id', requestId)
        .maybeSingle();

      if (existing) {
        return new Response(
          JSON.stringify({
            success: true,
            taskId: existing.id,
            status: existing.status,
            duplicate: true,
          }),
          { status: 200, headers: JSON_HEADERS }
        );
      }
    }

    // Insert task into hearth_tasks
    const { data: inserted, error: insertError } = await supabase
      .from('hearth_tasks')
      .insert({
        owner_id: device.owner_id,
        device_id: device.device_id,
        source: 'chatgpt',
        title: typeof title === 'string' ? title.slice(0, 200) : null,
        prompt: prompt.trim(),
        request_id: typeof requestId === 'string' ? requestId.trim() : null,
        status: 'pending',
      })
      .select('id, status, created_at')
      .single();

    if (insertError) {
      console.error('Failed to enqueue Hearth task:', insertError.message);
      return unavailable();
    }

    return new Response(
      JSON.stringify({
        success: true,
        taskId: inserted.id,
        status: inserted.status,
        createdAt: inserted.created_at,
      }),
      { status: 201, headers: JSON_HEADERS }
    );
  } catch (err: any) {
    console.error('create-hearth-task failed:', err?.message || err);
    return unavailable();
  }
});
