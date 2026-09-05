#!/bin/sh
set -eu

: "${SLACK_BASE_URL:?Load npx worldfixture env first}"
: "${SLACK_TOKEN:?Load npx worldfixture env first}"
command -v jq >/dev/null 2>&1 || { echo "This example needs jq." >&2; exit 1; }

authorization="Authorization: Bearer $SLACK_TOKEN"
form="Content-Type: application/x-www-form-urlencoded"
conversations=$(curl -fsS -X POST "$SLACK_BASE_URL/api/conversations.list" \
  -H "$authorization" -H "$form" \
  --data 'limit=100&types=public_channel,private_channel,mpim,im')

selected=""
latest="0"
for conversation_id in $(printf '%s' "$conversations" | jq -r '.channels[]?.id'); do
  history=$(curl -fsS -X POST "$SLACK_BASE_URL/api/conversations.history" \
    -H "$authorization" -H "$form" \
    --data-urlencode "channel=$conversation_id" --data 'limit=1')
  timestamp=$(printf '%s' "$history" | jq -r '.messages[0].ts // "0"')
  if awk "BEGIN { exit !($timestamp > $latest) }"; then
    latest=$timestamp
    selected=$conversation_id
  fi
done

[ -n "$selected" ] || { echo "Slack returned no visible conversation." >&2; exit 1; }
marker=${WORLDFIXTURE_EXAMPLE_TEXT:-"WorldFixture curl example $(date +%s)"}
curl -fsS -X POST "$SLACK_BASE_URL/api/chat.postMessage" \
  -H "$authorization" -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg channel "$selected" --arg text "$marker" '{channel:$channel,text:$text}')" >/dev/null

confirmed=$(curl -fsS -X POST "$SLACK_BASE_URL/api/conversations.history" \
  -H "$authorization" -H "$form" \
  --data-urlencode "channel=$selected" --data 'limit=20')
printf '%s' "$confirmed" | jq -e --arg text "$marker" 'any(.messages[]?; .text == $text)' >/dev/null
printf '%s\n' "Slack wrote and read back: $marker"
