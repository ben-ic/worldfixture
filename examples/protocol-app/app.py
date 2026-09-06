#!/usr/bin/env python3
"""A different-stack WorldFixture application using standard protocols only."""

import http.server
import imaplib
import json
import os
import pathlib
import smtplib
import subprocess
import threading
import time
import urllib.request
from email.message import EmailMessage

from s3_signing import s3_request

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = os.environ.get("WORLDFIXTURE_STATE", str(ROOT / ".worldfixture/runs/local"))
MARKER = f"WF_PYTHON_{int(time.time() * 1000)}"


def bindings():
    output = subprocess.check_output(
        ["node", str(ROOT / "runtime/bin/worldfixture.mjs"), "env", "--json", "--state", STATE],
        cwd=ROOT,
        text=True,
    )
    return json.loads(output)


class Callback(http.server.BaseHTTPRequestHandler):
    result = None

    def do_POST(self):
        size = int(self.headers.get("content-length", "0"))
        Callback.result = json.loads(self.rfile.read(size))
        self.send_response(202)
        self.end_headers()

    def log_message(self, *_args):
        pass


def request(url, *, method="GET", data=None, content_type=None):
    body = data.encode() if isinstance(data, str) else data
    headers = {"content-type": content_type} if content_type else {}
    with urllib.request.urlopen(urllib.request.Request(url, data=body, method=method, headers=headers), timeout=10) as response:
        return response.status, response.read()


def main():
    env = bindings()
    smtp_host, smtp_port = env["SMTP_HOST_PORT"].rsplit(":", 1)
    imap_host, imap_port = env["IMAP_HOST_PORT"].rsplit(":", 1)

    callback = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Callback)
    thread = threading.Thread(target=callback.serve_forever, daemon=True)
    thread.start()

    # HTTP target: standard HTTP, using the actual binding. This is the input
    # that causes this application to publish its callback result.
    status, website = request(env["SITE_BASE_URL"] + "/")
    if status != 200 or b"WorldFixture session data" not in website:
        raise RuntimeError("the seeded HTTP target did not return its accepted page")

    # SMTP: submit one normal RFC 5322 message as the configured world person.
    message = EmailMessage()
    message["From"] = env["SMTP_USERNAME"]
    message["To"] = env["IMAP_USERNAME"]
    message["Subject"] = f"Protocol check {MARKER}"
    message.set_content("The Python application completed its HTTP and S3 checks.")
    with smtplib.SMTP(smtp_host, int(smtp_port), timeout=10) as smtp:
        # The fixture's SMTP submission surface deliberately does not advertise
        # AUTH. Identity is the RFC 5322 sender; mailbox authentication happens
        # on IMAP below. Probe this behavior instead of assuming SMTP AUTH.
        smtp.send_message(message)

    # SeaweedFS S3: one PutObject and one GetObject over the S3 HTTP protocol.
    key = f"python-example/{MARKER}.json"
    object_url = env["S3_BASE_URL"] + "/northstar-relay-exports/" + key
    payload = json.dumps({"marker": MARKER, "website_status": status})
    s3_request(object_url, env, method="PUT", data=payload, content_type="application/json")
    _, stored = s3_request(object_url, env)
    if json.loads(stored)["marker"] != MARKER:
        raise RuntimeError("S3 did not return the object it accepted")

    # The application callback is a real local HTTP endpoint. It receives the
    # outcome only after the external protocol actions succeeded.
    callback_url = f"http://127.0.0.1:{callback.server_address[1]}/completed"
    request(callback_url, method="POST", data=json.dumps({"marker": MARKER, "s3_key": key}), content_type="application/json")

    # IMAP: verify the SMTP consequence through the mailbox protocol.
    found = False
    with imaplib.IMAP4(imap_host, int(imap_port)) as imap:
        imap.login(env["IMAP_USERNAME"], env["IMAP_PASSWORD"])
        imap.select("INBOX")
        for _ in range(20):
            _, ids = imap.search(None, "ALL")
            for message_id in ids[0].split()[-20:]:
                _, rows = imap.fetch(message_id, "(RFC822)")
                if MARKER.encode() in rows[0][1]:
                    found = True
                    break
            if found:
                break
            time.sleep(0.1)
    callback.shutdown()
    if not found or Callback.result is None:
        raise RuntimeError("the SMTP message or HTTP callback was not observed")

    print("WorldFixture Python protocol scenario completed")
    print(f"  SMTP -> IMAP  {MARKER}")
    print(f"  HTTP callback {callback_url}")
    print(f"  SeaweedFS S3  s3://northstar-relay-exports/{key}")
    print("Reset proof: run the command below, then run this app again.")
    print(f"  node ../../runtime/bin/worldfixture.mjs reset --state {STATE}")


if __name__ == "__main__":
    main()
