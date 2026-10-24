#!/usr/bin/env python3
"""Deploy Muse Bridge Web Worker ke Cloudflare (via API, tanpa wrangler).

Contoh pakai (dari folder web/):

  python3 deploy.py \
    --account-id <ACCOUNT_ID> \
    --db-id <D1_DATABASE_ID> \
    --worker-name muse-bridge \
    --hostname bridge.example.com

OWNER_PASSWORD dibaca dari environment variable OWNER_PASSWORD (tidak pernah
ditulis ke file):

  OWNER_PASSWORD='...' python3 deploy.py ...

Skrip ini ditulis untuk konektor Cloudflare Muse (surrogate credential
`custom.cloudflare`). Untuk pemakaian umum, ganti fungsi `cf_request` dengan
panggilan API Cloudflare ber-token milikmu sendiri.
"""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error
import uuid

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
try:
    from dynamic_credentials import add_surrogate_to_request, read_json_response, read_response_body
except ImportError:  # pemakaian di luar Muse: set CF_API_TOKEN
    add_surrogate_to_request = None

    def read_json_response(resp):
        return json.loads(resp.read().decode("utf-8"))

    def read_response_body(resp):
        return resp.read()


def cf_request(method, path, body=None, headers=None):
    url = "https://api.cloudflare.com" + path
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"Accept": "application/json",
                                          "User-Agent": "muse-bridge-deploy",
                                          **(headers or {})})
    if add_surrogate_to_request is not None:
        add_surrogate_to_request(req, "custom.cloudflare", entry_name="access_token",
                                 allowed_hosts=["api.cloudflare.com"])
    elif os.environ.get("CF_API_TOKEN"):
        req.add_header("Authorization", "Bearer " + os.environ["CF_API_TOKEN"])
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return read_json_response(resp)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {read_response_body(e).decode('utf-8', errors='replace')[:2000]}",
              file=sys.stderr)
        raise SystemExit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--account-id", required=True)
    ap.add_argument("--db-id", required=True)
    ap.add_argument("--worker-name", default="muse-bridge")
    ap.add_argument("--hostname", default="", help="Custom domain, mis. bridge.example.com (opsional)")
    ap.add_argument("--script", default=os.path.join(os.path.dirname(__file__), "worker.js"))
    args = ap.parse_args()

    script = open(args.script, "rb").read()
    metadata = {
        "main_module": "worker.js",
        "compatibility_date": "2024-09-23",
        "bindings": [{"type": "d1", "name": "DB", "id": args.db_id}],
    }

    boundary = uuid.uuid4().hex
    parts = []

    def add_field(name, data, filename=None, ctype=None):
        head = f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"'
        if filename:
            head += f'; filename="{filename}"'
        head += "\r\n"
        if ctype:
            head += f"Content-Type: {ctype}\r\n"
        head += "\r\n"
        parts.append(head.encode() + (data if isinstance(data, bytes) else data.encode()) + b"\r\n")

    add_field("metadata", json.dumps(metadata), ctype="application/json")
    add_field("worker.js", script, filename="worker.js", ctype="application/javascript+module")
    body = b"".join(parts) + f"--{boundary}--\r\n".encode()

    r = cf_request("PUT", f"/client/v4/accounts/{args.account_id}/workers/scripts/{args.worker_name}",
                   body=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    print("upload:", "OK" if r.get("success") else json.dumps(r)[:500])

    owner_pw = os.environ.get("OWNER_PASSWORD")
    if owner_pw:
        r = cf_request("PUT", f"/client/v4/accounts/{args.account_id}/workers/scripts/{args.worker_name}/secrets",
                       body=json.dumps({"name": "OWNER_PASSWORD", "text": owner_pw, "type": "secret_text"}).encode(),
                       headers={"Content-Type": "application/json"})
        print("secret OWNER_PASSWORD:", "OK" if r.get("success") else json.dumps(r)[:500])
    else:
        print("secret OWNER_PASSWORD: dilewati (env OWNER_PASSWORD tidak diset)")

    if args.hostname:
        r = cf_request("PUT", f"/client/v4/accounts/{args.account_id}/workers/domains",
                       body=json.dumps({"hostname": args.hostname, "service": args.worker_name,
                                        "environment": "production"}).encode(),
                       headers={"Content-Type": "application/json"})
        print("domain:", "OK" if r.get("success") else json.dumps(r)[:500])


if __name__ == "__main__":
    main()
