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
work. Complete production validation, errors, paging, callbacks, retries, rate
limits, and signatures also do not work. These operations are **Not supported**.
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

The local service maps `/messaging`, `/verify`, and `/conversations` under
one `TWILIO_BASE_URL`. Production Twilio uses different hosts. A client that
fixes those hosts must rewrite them to the local paths.

## Local simulator reference

| Method and path | Input | Output |
| --- | --- | --- |
| `POST /_twilio/simulate/inbound-message` | `To`, `From`, and optional `Body` form data | Local message |
| `POST /_twilio/simulate/message-status` | `MessageSid` and `Status` form data | Updated message |
| `POST /_twilio/simulate/inbound-call` | `To` and `From` form data | Local call |
| `POST /_twilio/simulate/call-status` | `CallSid`, `Status`, and optional `Twiml` form data | Updated call |
| `POST /_twilio/simulate/verification-status` | `Status`, one of `VerificationSid` or `To`, and optional `ServiceSid` | Updated verification |
| `GET /_twilio/simulate/verification-code` | `VerificationSid` or `To`, and optional `ServiceSid` query | Deterministic local code |

These controls are not Twilio API routes.

## State, callbacks, reset, Workbench, and proof

API and simulator writes change one store. The Workbench reads phone numbers,
Messaging Services, and Verify Services from the live API. It has no Twilio
write control.

Selected message and call callbacks use form data and
`X-Twilio-Signature`. Exact production signatures and retry timing are not
verified. Reset restarts and reseeds the store. Stop does not preserve this
state.

Implementation: emulate.dev for the routes and simulator. WorldFixture adds the
Account SID and Auth Token bindings. Proof is the route source, service
manifest, compiler projection tests, and live Workbench reads. No endpoint has
a response-contract test or production recording. No official SDK version has
a WorldFixture test.

Provider authority: [Twilio request authentication](https://www.twilio.com/docs/usage/requests-to-twilio),
[Messaging API](https://www.twilio.com/docs/messaging/api/message-resource), and
[Verify API](https://www.twilio.com/docs/verify/api).
