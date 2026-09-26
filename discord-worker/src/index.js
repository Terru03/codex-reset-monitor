const ACCOUNTS = {
  david: {
    label: "David",
    secret: "INGEST_TOKEN_DAVID",
    repo: "codex-reset-monitor",
  },
  nicu: {
    label: "Nicu",
    secret: "INGEST_TOKEN_NICU",
    repo: "codex-reset-monitor-nicu",
  },
};

const GITHUB_OWNER = "Terru03";
const GITHUB_WORKFLOW = "monitor.yml";
const GITHUB_REF = "main";
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const RESET_LOOKAHEAD_MS = 330 * 1000;
const PENDING_RUN_GRACE_MS = 7 * 60 * 1000;

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

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduler(env, Number(controller.scheduledTime) || Date.now()));
  },
};

async function runScheduler(env, scheduledTimeMs) {
  const nowMs = Number.isFinite(scheduledTimeMs) ? scheduledTimeMs : Date.now();

  for (const [account, config] of Object.entries(ACCOUNTS)) {
    try {
      await maybeDispatchMonitor(account, config, env, nowMs);
    } catch (error) {
      console.error(
        `Scheduler error for ${account}: ${String(error?.message || error).slice(0, 300)}`,
      );
    }
  }
}

async function maybeDispatchMonitor(account, config, env, nowMs) {
  const rawStatus = await env.CODEX_STATE.get(`status:${account}`);
  let status = null;
  if (rawStatus) {
    try {
      status = JSON.parse(rawStatus);
    } catch {
      status = null;
    }
  }

  const checkedMs = status ? Date.parse(status.checkedAt) : NaN;
  const stale =
    !Number.isFinite(checkedMs) ||
    nowMs - checkedMs >= CHECK_INTERVAL_MS;

  const resetSoon = hasUpcomingReset(status, nowMs);

  if (!stale && !resetSoon) {
    return;
  }

  const pendingRun = await findPendingOrNewerGithubRun(
    config.repo,
    env,
    checkedMs,
    nowMs,
  );
  if (pendingRun) {
    return;
  }

  await dispatchGithubWorkflow(config.repo, env);
}

async function findPendingOrNewerGithubRun(repo, env, checkedMs, nowMs) {
  if (!env.GITHUB_DISPATCH_TOKEN) {
    throw new Error("GITHUB_DISPATCH_TOKEN is missing");
  }

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/workflows/${GITHUB_WORKFLOW}/runs?branch=${encodeURIComponent(GITHUB_REF)}&per_page=10`,
    {
      headers: githubHeaders(env),
    },
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(
      `GitHub run lookup failed for ${repo}: HTTP ${response.status} ${detail}`,
    );
  }

  const payload = await response.json();
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];

  for (const run of runs) {
    const createdMs = Date.parse(run?.created_at || "");
    const statusName = String(run?.status || "");
    const active = ["queued", "in_progress", "waiting", "requested", "pending"].includes(statusName);

    if (active) {
      return run;
    }

    if (
      Number.isFinite(createdMs) &&
      nowMs - createdMs >= 0 &&
      nowMs - createdMs < PENDING_RUN_GRACE_MS &&
      (!Number.isFinite(checkedMs) || createdMs > checkedMs)
    ) {
      return run;
    }
  }

  return null;
}

function hasUpcomingReset(status, nowMs) {
  if (!status?.windows) return false;

  for (const key of ["300", "10080"]) {
    const resetAt = Number(status.windows?.[key]?.resetsAt);
    if (!Number.isFinite(resetAt)) continue;

    const resetMs = resetAt * 1000;
    if (resetMs > nowMs && resetMs - nowMs <= RESET_LOOKAHEAD_MS) {
      return true;
    }
  }

  return false;
}

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "codex-reset-monitor-worker/1.0",
  };
}

async function dispatchGithubWorkflow(repo, env) {
  if (!env.GITHUB_DISPATCH_TOKEN) {
    throw new Error("GITHUB_DISPATCH_TOKEN is missing");
  }

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: githubHeaders(env),
      body: JSON.stringify({ ref: GITHUB_REF }),
    },
  );

  if (response.status !== 204) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(
      `GitHub dispatch failed for ${repo}: HTTP ${response.status} ${detail}`,
    );
  }
}

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

function formatAvailableResets(status) {
  const available = [];
  const fiveUsed = Number(status?.windows?.["300"]?.usedPercent);
  const weeklyUsed = Number(status?.windows?.["10080"]?.usedPercent);

  if (
    Number.isFinite(fiveUsed) &&
    fiveUsed <= 0 &&
    Number.isFinite(weeklyUsed) &&
    weeklyUsed < 100
  ) {
    available.push("5-hour");
  }
  if (Number.isFinite(weeklyUsed) && weeklyUsed <= 0) {
    available.push("weekly");
  }

  return available.length ? available.join(", ") : "None";
}

function formatUsage(status) {
  const five = status.windows?.["300"];
  const weekly = status.windows?.["10080"];
  const checkedMs = Date.parse(status.checkedAt);
  const stale = Number.isFinite(checkedMs) && Date.now() - checkedMs > 15 * 60 * 1000;
  const staleLine = stale ? "\n\n⚠️ **Status is older than 15 minutes.**" : "";

  return (
    `**Codex usage — ${status.label}**\n\n` +
    `**Resets available:** ${formatAvailableResets(status)}\n\n` +
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
