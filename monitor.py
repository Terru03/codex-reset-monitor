#!/usr/bin/env python3
import datetime as dt
import json
import os
import pathlib
import subprocess
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
STATE_PATH = ROOT / "state" / "reset-state.json"


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_usage():
    proc = subprocess.run(
        ["python3", str(ROOT / "scripts" / "read_codex_usage.py")],
        check=True,
        capture_output=True,
        text=True,
        env=os.environ.copy(),
    )
    line = proc.stdout.strip().splitlines()[-1]
    return json.loads(line)


def choose_snapshot(payload):
    by_id = payload.get("rateLimitsByLimitId") or {}
    return by_id.get("codex") or payload.get("rateLimits") or {}


def normalise_windows(snapshot):
    out = {}
    for slot in ("primary", "secondary"):
        window = snapshot.get(slot)
        if not window:
            continue
        duration = window.get("windowDurationMins")
        if duration is None:
            key = slot
            label = slot
        else:
            duration = int(duration)
            key = str(duration)
            if duration == 300:
                label = "5-hour"
            elif duration == 10080:
                label = "weekly"
            elif duration % 1440 == 0:
                label = f"{duration // 1440}-day"
            elif duration % 60 == 0:
                label = f"{duration // 60}-hour"
            else:
                label = f"{duration}-minute"
        out[key] = {
            "label": label,
            "usedPercent": float(window.get("usedPercent", 0)),
            "resetsAt": int(window["resetsAt"]) if window.get("resetsAt") is not None else None,
            "durationMins": duration,
        }
    return out


def fmt_local(epoch):
    if epoch is None:
        return "unknown"
    tz = dt.timezone(dt.timedelta(hours=3))
    stamp = dt.datetime.fromtimestamp(epoch, dt.timezone.utc).astimezone(tz)
    return stamp.strftime("%d %b %Y, %H:%M EEST")


def discord_ping(window, previous_reset):
    webhook = os.environ.get("DISCORD_WEBHOOK_URL")
    user_id = os.environ.get("DISCORD_USER_ID", "").strip()
    if not webhook:
        raise RuntimeError("DISCORD_WEBHOOK_URL is missing")

    mention = f"<@{user_id}> " if user_id else ""
    content = (
        f"{mention}**Codex {window['label']} usage reset** ✅\n"
        f"Usage now: **{window['usedPercent']:.0f}%**\n"
        f"Previous reset point: {fmt_local(previous_reset)}\n"
        f"Next reset: {fmt_local(window['resetsAt'])}"
    )
    body = json.dumps({"content": content, "allowed_mentions": {"parse": ["users"]}}).encode()
    req = urllib.request.Request(
        webhook,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "codex-reset-monitor/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        if res.status not in (200, 204):
            raise RuntimeError(f"Discord returned HTTP {res.status}")


def main():
    payload = read_usage()
    snapshot = choose_snapshot(payload)
    windows = normalise_windows(snapshot)
    if not windows:
        raise RuntimeError("Codex returned no primary/secondary usage windows")

    now = utc_now()
    state = load_json(STATE_PATH, {"version": 1, "windows": {}})
    previous_windows = state.setdefault("windows", {})
    first_run = not previous_windows
    changed = False
    alerts = []

    for key, window in windows.items():
        current_reset = window.get("resetsAt")
        previous = previous_windows.get(key, {})
        previous_reset = previous.get("resetsAt")

        if (
            not first_run
            and previous_reset is not None
            and current_reset is not None
            and current_reset > previous_reset
        ):
            alerts.append((window, previous_reset))

        new_state = {
            "label": window["label"],
            "durationMins": window["durationMins"],
            "resetsAt": current_reset,
        }
        if previous != new_state:
            previous_windows[key] = new_state
            changed = True

    # Keep a public scheduled workflow alive even during long periods with no quota changes.
    heartbeat = state.get("heartbeatAt")
    heartbeat_dt = None
    if heartbeat:
        try:
            heartbeat_dt = dt.datetime.fromisoformat(heartbeat.replace("Z", "+00:00"))
        except ValueError:
            pass
    if heartbeat_dt is None or now - heartbeat_dt >= dt.timedelta(days=30):
        state["heartbeatAt"] = now.isoformat().replace("+00:00", "Z")
        changed = True

    state["lastCheckedAt"] = now.isoformat().replace("+00:00", "Z")
    # lastCheckedAt is intentionally not used to decide whether to commit.
    if changed:
        save_json(STATE_PATH, state)

    for window, previous_reset in alerts:
        discord_ping(window, previous_reset)

    print(json.dumps({
        "firstRun": first_run,
        "alertsSent": len(alerts),
        "stateChanged": changed,
        "windows": windows,
    }, indent=2))


if __name__ == "__main__":
    main()
