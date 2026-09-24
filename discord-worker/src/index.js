const ACCOUNTS = {
  david: { label: "David", secret: "INGEST_TOKEN_DAVID" },
  nicu: { label: "Nicu", secret: "INGEST_TOKEN_NICU" },
};

const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "codex-usage-discord" });
    }

    if (request.method === "POST" && url.pathname === "/ingest") {
      return ingest(request, env);
    }

    if (request.method === "POST" && url.pathname === "/discord") {
      return discordInteraction(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function ingest(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const account = String(payload?.account || "").toLowerCase();
  const accountConfig = ACCOUNTS[account];
  if (!accountConfig) return json({ error: "unknown account" }, 400);

  const expectedToken = env[accountConfig.secret];
  const supplied = bearerToken(request.headers.get("Authorization"));
  if (!expectedToken || !supplied || supplied !== expectedToken) {
    return json({ error: "unauthorized" }, 401);
  }

  const status = normaliseStatus(payload, account, accountConfig.label);
  if (!status) return json({ error: "invalid status payload" }, 400);

  await env.CODEX_STATE.put(`status:${account}`, JSON.stringify(status));
  return json({ ok: true, account });
}

async function discordInteraction(request, env) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) {
    return new Response("Bad request signature", { status: 401 });
  }

  const body = await request.text();
  const verified = await verifyDiscordRequest(
    env.DISCORD_PUBLIC_KEY,
    signature,
    timestamp,
    body,
  );
  if (!verified) return new Response("Bad request signature", { status: 401 });

  let interaction;
  try {
    interaction = JSON.parse(body);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  if (interaction.type === 1) {
    return json({ type: 1 });
  }

  if (interaction.type !== 2) {
    return interactionMessage("Unsupported interaction.", true);
  }

  const callerId = interaction.member?.user?.id || interaction.user?.id || "";
  const allowedUserId = env.DISCORD_ALLOWED_USER_ID || env.DISCORD_USER_ID || "";
  if (allowedUserId && callerId !== allowedUserId) {
    return interactionMessage("This usage command is private.", true);
  }

  const command = String(interaction.data?.name || "");
  const account =
    command === "usage-david" ? "david" :
    command === "usage-nicu" ? "nicu" :
    null;

  if (!account) return interactionMessage("Unknown command.", true);

  const raw = await env.CODEX_STATE.get(`status:${account}`);
  if (!raw) {
    return interactionMessage(
      `No status has been received for **${ACCOUNTS[account].label}** yet.`,
      true,
    );
  }

  let status;
  try {
    status = JSON.parse(raw);
  } catch {
    return interactionMessage("Stored status is invalid.", true);
  }

  return interactionMessage(formatUsage(status), true);
}

function normaliseStatus(payload, account, fallbackLabel) {
  const windows = payload?.windows;
  if (!windows || typeof windows !== "object") return null;

  const five = normaliseWindow(windows["300"]);
  const weekly = normaliseWindow(windows["10080"]);
  if (!five || !weekly) return null;

  const checkedAt = new Date(payload.checkedAt);
  if (Number.isNaN(checkedAt.getTime())) return null;

  return {
    version: 1,
    account,
    label: String(payload.label || fallbackLabel).slice(0, 40),
    checkedAt: checkedAt.toISOString(),
    windows: { "300": five, "10080": weekly },
  };
}

function normaliseWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = Number(window.usedPercent);
  const resetsAt = Number(window.resetsAt);
  if (!Number.isFinite(usedPercent) || !Number.isFinite(resetsAt)) return null;
  return {
    usedPercent,
    resetsAt: Math.trunc(resetsAt),
  };
}

function formatUsage(status) {
  const five = status.windows?.["300"];
  const weekly = status.windows?.["10080"];
  const checkedMs = Date.parse(status.checkedAt);
  const stale = Number.isFinite(checkedMs) && Date.now() - checkedMs > 15 * 60 * 1000;
  const staleLine = stale ? "\n\n⚠️ **Status is older than 15 minutes.**" : "";

  return (
    `**Codex usage — ${status.label}**\n\n` +
    `**5-hour:** ${formatRemaining(five?.usedPercent)} remaining\n` +
    `Next reset: **${formatRomania(five?.resetsAt)}**\n\n` +
    `**Weekly:** ${formatRemaining(weekly?.usedPercent)} remaining\n` +
    `Next reset: **${formatRomania(weekly?.resetsAt)}**\n\n` +
    `Last checked: ${formatRomania(Math.floor(checkedMs / 1000))}` +
    staleLine
  );
}

function formatRemaining(usedValue) {
  const used = Number(usedValue);
  if (!Number.isFinite(used)) return "unknown";
  const remaining = Math.max(0, Math.min(100, 100 - used));
  return `${Math.round(remaining)}%`;
}

function formatRomania(epoch) {
  if (!Number.isFinite(Number(epoch))) return "unknown";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Bucharest",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(new Date(Number(epoch) * 1000));
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${p.day} ${String(p.month).replace("Sept", "Sep")} ${p.year}, ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

async function verifyDiscordRequest(publicKeyHex, signatureHex, timestamp, body) {
  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      hexToBytes(signatureHex),
      encoder.encode(timestamp + body),
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const clean = String(hex).trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) {
    throw new Error("bad hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(header || "");
  return match ? match[1].trim() : "";
}

function interactionMessage(content, ephemeral) {
  return json({
    type: 4,
    data: {
      content,
      ...(ephemeral ? { flags: 64 } : {}),
      allowed_mentions: { parse: [] },
    },
  });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
