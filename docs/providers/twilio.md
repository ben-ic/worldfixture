# Twilio

## What works

WorldFixture supports selected Accounts, phone numbers, Messages, Calls,
Messaging Services, Verify, and Conversations routes. It also has local
simulator controls. API support label: **Supported but partial**. Simulator
label: **Workbench-only**.

## What does not work

No carrier sends a message. No telephone network places a call. Production
number purchase, Conversations WebSockets, Studio, Flex, TaskRouter, Video,
Sync, Segment, SendGrid, billing, compliance, and all unlisted products do not
work. Complete production validation, errors, paging, callback coverage,
retries, and rate limits also do not work. These operations are **Not supported**.
Production behavior and the official Twilio SDK are
**Not verified against the production provider**.

## Connect

Use these generated bindings:

```text
TWILIO_BASE_URL=<dynamic local HTTP URL>
TWILIO_ACCOUNT_SID=<world Account SID>
TWILIO_AUTH_TOKEN=<world Auth Token>
```

Use HTTP Basic authentication. The username is `TWILIO_ACCOUNT_SID`. The
password is `TWILIO_AUTH_TOKEN`. `TWILIO_TOKEN` is an old bearer-token
binding. It is not the Auth Token.

WorldFixture uses the internal Twilio module from `emulate` 0.10.0.

## Core route reference

All create and update calls use Twilio form data.

| Resource | Exact methods and paths | Output | Proof |
| --- | --- | --- | --- |
| Accounts | `GET /2010-04-01/Accounts.json`<br>`GET, POST /2010-04-01/Accounts/:accountSid.json` | Account list or account object | Registered route source |
| Incoming numbers | `GET, POST /2010-04-01/Accounts/:accountSid/IncomingPhoneNumbers.json`<br>`GET, POST, DELETE /2010-04-01/Accounts/:accountSid/IncomingPhoneNumbers/:sid.json` | Number list, number object, or delete result | Registered route source |
| Messages | `GET, POST /2010-04-01/Accounts/:accountSid/Messages.json`<br>`GET, POST, DELETE /2010-04-01/Accounts/:accountSid/Messages/:messageSid.json` | Message list, message object, or delete result | Registered route source |
| Message media | `GET /2010-04-01/Accounts/:accountSid/Messages/:messageSid/Media.json`<br>`GET /2010-04-01/Accounts/:accountSid/Messages/:messageSid/Media/:mediaSid.json` | Media list or media object | Registered route source |
| Calls | `GET, POST /2010-04-01/Accounts/:accountSid/Calls.json`<br>`GET, POST, DELETE /2010-04-01/Accounts/:accountSid/Calls/:callSid.json` | Call list, call object, or delete result | Registered route source |

Objects use fields such as `sid`, `account_sid`, `friendly_name`,
`phone_number`, `from`, `to`, `body`, `status`, `date_created`, and
`date_updated`. List envelopes use keys such as `accounts`,
`incoming_phone_numbers`, `messages`, `media_list`, and `calls`.

## Product route reference

| Resource | Exact methods and paths | Input and output | Proof |
| --- | --- | --- | --- |
| Messaging Services | `GET, POST /messaging/v1/Services`<br>`GET, POST, DELETE /messaging/v1/Services/:serviceSid` | Form data; service list, object, or delete result | Registered route source |
| Service numbers | `GET, POST /messaging/v1/Services/:serviceSid/PhoneNumbers`<br>`DELETE /messaging/v1/Services/:serviceSid/PhoneNumbers/:sid` | Number SID form; assignment data | Registered route source |
| Verify Services | `GET, POST /verify/v2/Services`<br>`GET, POST, DELETE /verify/v2/Services/:serviceSid` | Form data; service data | Registered route source |
| Verifications | `POST /verify/v2/Services/:serviceSid/Verifications`<br>`GET, POST /verify/v2/Services/:serviceSid/Verifications/:verificationSid` | Recipient and channel form; verification data | Registered route source |
| Verification check | `POST /verify/v2/Services/:serviceSid/VerificationCheck` | Code form; check result | Registered route source |
| Conversation Services | `GET, POST /conversations/v1/Services`<br>`GET /conversations/v1/Services/:serviceSid` | Form data; service data | Registered route source |
| Conversations | `GET, POST /conversations/v1/Services/:serviceSid/Conversations`<br>`GET, POST, DELETE /conversations/v1/Services/:serviceSid/Conversations/:conversationSid` | Form data; conversation data | Registered route source |
| Participants | `GET, POST /conversations/v1/Services/:serviceSid/Conversations/:conversationSid/Participants` | Participant form; participant data | Registered route source |
| Conversation messages | `GET, POST /conversations/v1/Services/:serviceSid/Conversations/:conversationSid/Messages` | Message form; message data | Registered route source |
| Conversation webhook configuration | `GET, POST /conversations/v1/Services/:serviceSid/Configuration/Webhooks` | `PostWebhookUrl`, repeated `Filters`, and `Method` form fields; native configuration object | HTTP receiver tests |

The local service maps `/messaging`, `/verify`, and `/conversations` under
one `TWILIO_BASE_URL`. Production Twilio uses different hosts. A client that
fixes those hosts must rewrite them to the local paths.

## Local simulator reference

| Method and path | Input | Output |
| --- | --- | --- |
| `POST /_twilio/simulate/inbound-message` | `To`, `From`, and optional `Body` form data | Local message |
| `POST /_twilio/simulate/message-status` | `MessageSid`, `Status`, and optional `ErrorCode` and `ErrorMessage` form data | Updated message |
| `POST /_twilio/simulate/inbound-call` | `To` and `From` form data | Local call |
| `POST /_twilio/simulate/call-status` | `CallSid`, `Status`, and optional `Twiml` form data | Updated call |
| `POST /_twilio/simulate/verification-status` | `Status`, one of `VerificationSid` or `To`, and optional `ServiceSid` | Updated verification |
| `GET /_twilio/simulate/verification-code` | `VerificationSid` or `To`, and optional `ServiceSid` query | Deterministic local code |

These controls are not Twilio API routes.

## State, callbacks, reset, Workbench, and proof

API and simulator writes change one store. The Workbench reads phone numbers,
Messaging Services, and Verify Services from the live API. It has no Twilio
write control.

Message status callbacks use `StatusCallback` from the message, or from its
Messaging Service when the message has no override. Creation does not send
an initial status callback. A later status change sends `AccountSid`,
`MessageSid`, `SmsSid`, `MessageStatus`, `SmsStatus`, `From`, and `To`.
`MessagingServiceSid` and `ErrorCode` are included when available.

Call status callbacks use `StatusCallbackMethod` (`POST` or `GET`) and repeated
`StatusCallbackEvent` fields. Supported events are `initiated`, `ringing`,
`answered`, and `completed`. The default is `completed`. The `answered` event
has `CallStatus=in-progress`. All terminal statuses match `completed`.
Requests contain live call IDs, phone numbers, `Caller`, `Called`,
`Direction`, `ApiVersion`, `CallbackSource=call-progress-events`, `Timestamp`,
and a `SequenceNumber` that starts at zero. Terminal events include duration.

Inbound simulator requests send SMS fields to `SmsUrl` and call fields to
`VoiceUrl`, with the configured method. SMS bodies retain Unicode and form
characters. The Voice request has `CallStatus=ringing`.
For a number in a Messaging Service, `InboundRequestUrl` and `InboundMethod`
select the SMS receiver. `UseInboundWebhookOnNumber=true` selects the number's
`SmsUrl` and `SmsMethod`. An empty service URL with this override disabled sends
no callback. The simulator still stores that message; production disables
receipt and message logging in this case.

Conversations service configuration supports these post-action filters:
`onConversationAdded`, `onConversationUpdated`, `onConversationRemoved`,
`onConversationStateUpdated`, `onMessageAdded`, and `onParticipantAdded`.
REST writes must include `X-Twilio-Webhook-Enabled: true` to send these events.
The receiver gets native form fields with `AccountSid`, `EventType`, `ChatServiceSid`,
`ConversationSid`, resource SIDs, dates, and resource values. `Index` is the
message index; `Attributes` remains a JSON string. Explicit `MessagingServiceSid`
values persist on Conversations and appear in callbacks. The default Message
`author` is `system` in both the API resource and callback. Participant creation
callbacks include `RetryCount=0`. An empty `PostWebhookUrl`
stops delivery. Unsupported filters and nonempty `PreWebhookUrl` values return
an error. Global and conversation-scoped webhook configuration is not supported.

`POST` callbacks use `application/x-www-form-urlencoded`. `GET` callbacks put
fields in the query string. Both methods send `X-Twilio-Signature`, calculated
with HMAC-SHA1 and the account Auth Token. Signature verification uses the
exact request URL and decoded form values. URL fragments are excluded.
Callbacks run asynchronously. A slow receiver, HTTP error, or timeout does not
fail the API write. The store records delivery results. Automatic retries,
carrier data, role data, recordings, and execution of returned TwiML are not
supported.

Delivery makes one attempt with a local 10-second total timeout by default.
It does not implement Twilio's separate connection and read timeouts, the
5-second Conversations timeout, URL fragment retry controls, or fallback URLs.
Twilio's documented default connection retry is therefore absent locally.
Call progress occurs through local simulation; production call timing, SIP
response codes, carrier delivery dates, and channel-specific message fields
are not verified. Optional resource fields and validation remain partial.

Reset restarts and reseeds the store. Stop does not preserve this state.

Provider authority: [Twilio request authentication](https://www.twilio.com/docs/usage/requests-to-twilio),
[Messaging API](https://www.twilio.com/docs/messaging/api/message-resource), and
[Verify API](https://www.twilio.com/docs/verify/api).
Callback authority: [request signatures](https://www.twilio.com/docs/usage/security),
[message status callbacks](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status),
[Voice callbacks](https://www.twilio.com/docs/voice/api/call-resource),
[Conversations callback fields](https://www.twilio.com/docs/conversations-classic/conversations-webhooks),
and [service webhook configuration](https://www.twilio.com/docs/conversations-classic/api/per-service-webhook-resource).
See also: [Messaging Service inbound routing](https://www.twilio.com/docs/messaging/api/service-resource),
[Conversation resource](https://www.twilio.com/docs/conversations-classic/api/conversation-resource),
[Conversation Message author](https://www.twilio.com/docs/conversations-classic/api/conversation-message-resource),
and [connection overrides and retries](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides).
