import json
import os
import time
import unicodedata
from pathlib import Path
from datetime import datetime

import requests
from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
CONFIG_PATH = BASE_DIR / "config.json"

VT_TOKEN_URL = "https://ext-api.vasttrafik.se/token"
VT_API_BASE = "https://ext-api.vasttrafik.se/pr/v4"

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
session = requests.Session()
_token = {"value": None, "expires_at": 0.0}
_stop_cache = {}


def load_config():
    cfg = {}
    if CONFIG_PATH.exists():
        with CONFIG_PATH.open("r", encoding="utf-8") as f:
            cfg = json.load(f)
    return {
        "client_id": os.getenv("VASTTRAFIK_CLIENT_ID", cfg.get("vasttrafik_client_id", "")),
        "client_secret": os.getenv("VASTTRAFIK_CLIENT_SECRET", cfg.get("vasttrafik_client_secret", "")),
        "stop_a": os.getenv("STOP_A", cfg.get("stop_a", "Varekil busstation")),
        "stop_b": os.getenv("STOP_B", cfg.get("stop_b", "Stenungsön")),
    }


def norm(text):
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return " ".join(text.casefold().split())


def get_token():
    cfg = load_config()
    if not cfg["client_id"] or not cfg["client_secret"]:
        raise RuntimeError("Västtrafik Client ID/Secret saknas i config.json eller miljövariabler.")

    now = time.time()
    if _token["value"] and _token["expires_at"] > now + 60:
        return _token["value"]

    response = session.post(
        VT_TOKEN_URL,
        auth=(cfg["client_id"], cfg["client_secret"]),
        data={"grant_type": "client_credentials"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=15,
    )
    response.raise_for_status()
    data = response.json()
    _token["value"] = data["access_token"]
    _token["expires_at"] = now + int(data.get("expires_in", 3600))
    return _token["value"]


def vt_get(path, params=None):
    token = get_token()
    response = session.get(
        f"{VT_API_BASE}{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {token}"},
        timeout=20,
    )
    if response.status_code == 401:
        _token["value"] = None
        token = get_token()
        response = session.get(
            f"{VT_API_BASE}{path}",
            params=params or {},
            headers={"Authorization": f"Bearer {token}"},
            timeout=20,
        )
    response.raise_for_status()
    return response.json()


def resolve_stop(query):
    cache_key = norm(query)
    if cache_key in _stop_cache:
        return _stop_cache[cache_key]

    data = vt_get(
        "/locations/by-text",
        {"q": query, "limit": 10, "types": "stoparea"},
    )
    results = data.get("results", [])
    if not results:
        raise RuntimeError(f"Hittade ingen Västtrafik-hållplats för '{query}'.")

    qn = norm(query)

    def score(item):
        name = norm(item.get("name", ""))
        if name == qn:
            return 0
        if name.startswith(qn) or qn.startswith(name):
            return 1
        if qn in name:
            return 2
        return 3

    selected = sorted(results, key=score)[0]
    stop = {"gid": selected["gid"], "name": selected.get("name", query)}
    _stop_cache[cache_key] = stop
    return stop


def choose_time(obj):
    return obj.get("estimatedTime") or obj.get("plannedTime") or ""


def shape_journey(journey):
    legs = journey.get("tripLegs", [])
    shaped_legs = []
    for leg in legs:
        origin = leg.get("origin", {}) or {}
        destination = leg.get("destination", {}) or {}
        service = leg.get("serviceJourney") or {}
        line = service.get("line") or {}
        shaped_legs.append({
            "origin": (origin.get("stopPoint") or {}).get("name") or origin.get("name") or "",
            "destination": (destination.get("stopPoint") or {}).get("name") or destination.get("name") or "",
            "departure": choose_time(origin),
            "plannedDeparture": origin.get("plannedTime", ""),
            "arrival": choose_time(destination),
            "plannedArrival": destination.get("plannedTime", ""),
            "line": line.get("shortName") or line.get("name") or "",
            "direction": service.get("direction", ""),
            "mode": line.get("transportMode") or ("walk" if not service else ""),
            "isTransport": bool(service),
        })

    transport_legs = [x for x in shaped_legs if x["isTransport"]]
    return {
        "departure": shaped_legs[0]["departure"] if shaped_legs else "",
        "arrival": shaped_legs[-1]["arrival"] if shaped_legs else "",
        "changes": max(0, len(transport_legs) - 1),
        "lines": [x["line"] for x in transport_legs if x["line"]],
        "legs": shaped_legs,
    }


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/manifest.webmanifest")
def manifest():
    return send_from_directory(STATIC_DIR, "manifest.webmanifest")


@app.get("/sw.js")
def service_worker():
    return send_from_directory(STATIC_DIR, "sw.js", mimetype="application/javascript")


@app.get("/api/route")
def route_info():
    try:
        cfg = load_config()
        a = resolve_stop(cfg["stop_a"])
        b = resolve_stop(cfg["stop_b"])
        return jsonify({"a": a, "b": b})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.get("/api/journeys")
def journeys():
    try:
        cfg = load_config()
        direction = request.args.get("direction", "a-b")
        date_time = request.args.get("dateTime", "").strip()
        limit = min(max(int(request.args.get("limit", 10)), 1), 20)

        a = resolve_stop(cfg["stop_a"])
        b = resolve_stop(cfg["stop_b"])
        origin, destination = (a, b) if direction == "a-b" else (b, a)

        params = {
            "originGid": origin["gid"],
            "destinationGid": destination["gid"],
            "limit": limit,
        }
        if date_time:
            params["dateTime"] = date_time

        data = vt_get("/journeys", params)
        results = [shape_journey(j) for j in data.get("results", [])]
        return jsonify({
            "origin": origin,
            "destination": destination,
            "results": results,
            "generatedAt": datetime.now().astimezone().isoformat(),
        })
    except requests.HTTPError as exc:
        body = ""
        try:
            body = exc.response.text[:500]
        except Exception:
            pass
        return jsonify({"error": f"Västtrafik svarade med fel: {exc}. {body}"}), 502
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.get("/api/health")
def health():
    cfg = load_config()
    return jsonify({
        "ok": True,
        "credentialsConfigured": bool(cfg["client_id"] and cfg["client_secret"]),
        "stopA": cfg["stop_a"],
        "stopB": cfg["stop_b"],
    })


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    app.run(host="0.0.0.0", port=port, debug=False)
