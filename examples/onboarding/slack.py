import os
import time

from slack_sdk import WebClient

base_url = os.environ.get("SLACK_BASE_URL")
token = os.environ.get("SLACK_TOKEN")
if not base_url or not token:
    raise SystemExit("Load `npx worldfixture env` before you run this example.")

client = WebClient(token=token, base_url=f"{base_url.rstrip('/')}/api/")
listed = client.conversations_list(limit=100, types="public_channel,private_channel,mpim,im")
histories = []
for conversation in listed.get("channels", []):
    history = client.conversations_history(channel=conversation["id"], limit=1)
    messages = history.get("messages", [])
    latest = float(messages[0].get("ts", 0)) if messages else 0
    histories.append((latest, conversation))

if not histories:
    raise SystemExit("Slack returned no visible conversation.")

_, selected = max(histories, key=lambda entry: entry[0])
marker = os.environ.get("WORLDFIXTURE_EXAMPLE_TEXT", f"WorldFixture Python SDK example {int(time.time() * 1000)}")
sent = client.chat_postMessage(channel=selected["id"], text=marker)
confirmed = client.conversations_history(channel=selected["id"], limit=20)
if not any(message.get("text") == marker for message in confirmed.get("messages", [])):
    raise SystemExit("Slack accepted the write, but the read-back did not contain it.")

print({"conversation": selected.get("name", selected["id"]), "ts": sent.get("ts"), "text": marker})
