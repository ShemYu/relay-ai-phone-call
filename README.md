# Relay — personal phone-call assistant

A local service for giving an AI a phone number, a goal, context, and boundaries, then explicitly asking it to place one call. Speech uses **`gpt-live-1`**. A separate Responses backend (`gpt-5.6-terra` by default) reasons over the brief and records the result. Twilio makes the outbound telephone call.

For the system diagram, call sequence, module responsibilities, and browser audio paths, see [Architecture](docs/architecture.md).

## Run locally

Requires Node.js 22.6 or newer.

```sh
npm install
npm start
```

Open **http://localhost:3210**. Preparing and reviewing a brief works without credentials. Calling stays disabled until configuration is present. No call starts merely by saving a brief, opening the page, or restarting the server.

## Test the voice in your browser

Choose **Test voice locally** in Relay, or open **http://localhost:3210/local-test.html**. Press **Start voice test** and allow microphone access to talk directly with GPT-Live over WebRTC. This needs the saved OpenAI key, but no Twilio configuration, phone number purchase, or public tunnel. It uses OpenAI over the internet and incurs API usage; it is not an offline model. No phone call is placed.

The page copies the latest reviewed brief and uses the same model, selected voice (Marin by default), opening, conversation instructions, and backend tools as phone mode. Editing the test brief does not change the phone brief. Goal completion can still end the conversation. WebRTC negotiates its audio codec instead of using the telephone bridge's 8 kHz μ-law stream. Only one phone call or browser test can run at a time.

Use these comparisons when speech sounds unclear:

- **Microphone check:** record and play back five seconds locally. If this already sounds distorted, investigate the microphone, input processing, or playback device. This recording stays in browser memory and is discarded when the page closes.
- **Browser voice test:** if this sounds clear while the phone call does not, investigate the phone codec, relay, and carrier path.
- **Connection statistics:** packet loss, jitter, and round-trip delay during the browser test can support a network-delivery explanation when they coincide with glitches. They cannot identify your Wi-Fi or internet provider as the cause. Clean statistics also do not rule out synthesis, codec, or device issues.

Browser captions and the model-reported outcome remain in the page and are not saved to phone-call history. End the test with **End test**. Relay waits for final usage confirmation and has a server-side session-close fallback if the page disappears or stops sending heartbeats. A timeout is shown as unconfirmed final usage, not a confirmed graceful shutdown.

## Connect the accounts

Configure the OpenAI project key in `.env.local`, using `OPENAI_API_KEY`. The key must have access to both `gpt-live-1` and the configured backend model. Complete the Twilio and public callback settings before calling.

Use `.env.example` as the configuration reference. Store account credentials in the ignored `.env.local` file, never in browser code or version control. Existing shell environment values take precedence over the file.

| Setting | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Project key with access to `gpt-live-1` and the selected backend model |
| `OPENAI_BACKEND_MODEL` | Optional; defaults to `gpt-5.6-terra` |
| `TWILIO_ACCOUNT_SID` | Your Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token; also verifies callbacks and media connections |
| `TWILIO_PHONE_NUMBER` | Voice-capable Twilio caller number in international format, such as `+12025550100` |
| `PUBLIC_BASE_URL` | Public HTTPS origin pointing to the callback listener on port **3211** |
| `PORT` | Local dashboard port; defaults to 3210 |
| `WEBHOOK_PORT` | Callback listener port; defaults to 3211 |

Create a Twilio account and choose a voice-capable number suitable for your calling destination. **An upgraded account is required:** the current [Twilio Voice trial restrictions](https://www.twilio.com/docs/usage/trials/try-out-voice#blocked-verbs) block the `<Stream>` verb used by this app, even when calling a verified number. Enable the destination in Twilio's [Voice geographic permissions](https://www.twilio.com/docs/voice/api/voice-dialing-geographic-permissions). Number availability and requirements depend on the selected country. Number rental and call usage are billed separately.

Expose **only port 3211** through a public HTTPS tunnel. For example, if ngrok is installed and configured:

```sh
ngrok http 3211
```

Alternatively, install Cloudflare Tunnel (`cloudflared`) using the official installation instructions, then run:

```sh
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3211
```

Keep that process running. [Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) are temporary development connections; their address changes when restarted and they have no uptime guarantee. Use a managed tunnel or hosted callback server for regular use.

Open **Connection settings** in the dashboard to save the Twilio account SID, Auth Token, caller number, and resulting `https://…` callback origin (no path or query). Settings are stored in the ignored, owner-only `.env.local` file and applied immediately while no call is active. A blank Auth Token field keeps the existing token; saved tokens are never returned to the browser. OpenAI configuration remains in `.env.local`. If editing the file directly, restart the app.

The service supplies each call's media and status callback URLs when placing the call; no OpenAI SIP webhook or audio recording configuration is needed. The browser setup checklist reports whether values are configured, not whether provider access has been verified.

**Keep port 3210 local.** It serves the personal dashboard and can initiate calls. Port 3211 serves only signed Twilio callbacks and media; it does not expose the dashboard, call briefs, or calling API. Both listeners bind to loopback. Multiuser access or public dashboard deployment requires adding authentication and authorization first.

## Japan and Taiwan

One US local voice number can serve ordinary Japanese and Taiwanese mobile and landline destinations. Enable the required low-risk destinations in Twilio Voice geographic permissions, while keeping high-risk ranges disabled. Use international format and remove the domestic leading zero:

| Destination | Domestic example | International format |
| --- | --- | --- |
| Japan | `090-1234-5678` | `+819012345678` |
| Taiwan | `0912-345-678` | `+886912345678` |

These are formatting examples, not test-call targets. Select Japanese or Mandarin Chinese (Taiwan) in the brief. International caller ID may affect whether a recipient answers. Start with ordinary mobile or landline numbers; Japanese `0570` and other special-service ranges need separate verification, and Twilio does not support calling Taiwan toll-free numbers. See the current [Japan](https://www.twilio.com/en-us/guidelines/jp/voice) and [Taiwan](https://www.twilio.com/en-us/guidelines/tw/voice) voice guidelines. Number rental, destination call usage, Media Streams, and OpenAI usage are separate charges.

## First call

1. Start with a number you control or a recipient expecting your test call.
2. Enter the caller name, recipient, international phone number, language, goal, shareable facts, constraints, and maximum duration. Choose **No time limit** to disable Relay's duration cutoff; provider limits still apply.
3. Review the exact brief and opening line. For languages other than English, Japanese, or Chinese, the default opening preview is in English; the voice prompt instructs the assistant to use the selected language.
4. Press **Place call**. A model-access check runs and the voice session becomes ready before dialing. This uses your API and phone-provider accounts and can incur charges, including voice-session time while the phone rings.
5. Follow the transcript or press **Stop call**. Review the outcome and any confirmation details afterward.

Each brief can choose Marin, Gleam, Willow, or Quartz and supply an optional opening message. The assistant is instructed to follow a custom opening without adding an extra introduction. Leave it blank for a simple greeting in the selected language, followed by a pause for the recipient. After their reply, the assistant moves naturally into the goal. Expand **Customize first words** only when needed. The reviewed opening and voice are saved for that call, and voice changes apply to new sessions. Gleam, Willow, and Quartz are listed as feminine voices in the [official Live voice options](https://developers.openai.com/api/docs/guides/live-conversations#voice-options); speaking style and pronunciation in Taiwan Mandarin still need a listening check.

There is no forced AI announcement. The assistant uses ordinary conversational language and gives a brief, honest identity reply if asked. It handles light jokes briefly and respects a clear refusal. It is instructed to work within the brief, clarify missing facts, read back critical details, and end politely when declined. These are prompt instructions, not deterministic guarantees about speech. Keep the first use case simple and assess actual audio and behavior before relying on it for consequential commitments.

After changing the conversation prompt, restart the server and start a new session. Review a fresh phone brief to use a changed opening; previously reviewed briefs retain their original opening. Browser tests generate the opening at session creation. The current style follows the [GPT-Live prompting guidance](https://developers.openai.com/api/docs/guides/live-prompting): describe conversational behavior and let the voice model choose ordinary replies.

## How the call works

### Listen to an active phone call

In the call panel, press **Listen** to hear the recipient and assistant through your browser. Browser playback requires this explicit click. Use **Mute**, the volume control, or **Stop listening**; stopping listening leaves the phone call running. The separate **End call** button ends the phone call. Listening never opens your microphone or sends browser audio to the recipient.

Audio is copied from authenticated incoming phone media and the assistant audio sent to Twilio, streamed only through the local dashboard, and decoded in the browser. Nothing is recorded or replayed: joining mid-call starts with new audio. Both speakers can overlap. The preview has a small playback buffer; the AI track represents submitted audio, so its timing may differ from what the recipient actually hears through the carrier. See [Twilio media and playback behavior](https://www.twilio.com/docs/voice/media-streams/websocket-messages).

If the monitor falls behind or disconnects, its queued playback is cleared and you can press **Listen** again. This does not stop or slow the phone stream. Listener count and buffers are bounded, and ending the call closes its listeners. Past calls have transcripts but no audio playback.

```text
Local dashboard → reviewed brief → explicit Call
  → OpenAI model-access check → GPT-Live session ready → Twilio outbound Calls API
  → recipient answers → Twilio bidirectional Media Stream
  ↔ local callback server ↔ GPT-Live WebSocket (gpt-live-1)
                           ↔ delegated Responses reasoning
  → transcripts + model-reported outcome → local dashboard
```

The bridge forwards G.711 μ-law audio at 8 kHz directly. It waits for `session.started` **before dialing**, so connection setup does not leave the recipient's audio permanently queued behind live speech. Audio stays paced at its original sample rate, with no speech discarded or sped up to clear a startup backlog. Greeting, playback, transcripts, and call-tool side effects wait for the authenticated phone stream. A prepared voice session closes if the phone stream has not connected within 60 seconds; an uncertain phone-provider result still blocks redialing until disconnection is confirmed. The bridge handles backend function results and waits for `session.closed` to record final voice usage. The `report_call_outcome` tool records results; `end_call` ends the line after the assistant's goodbye and a bounded playback wait.

## Reliability and current limits

- One active phone call or browser test at a time; repeated requests for the same reviewed phone brief return the original call instead of dialing twice. Edit/review a new brief for an intentional second attempt.
- Signed HTTP callbacks and signed WSS upgrades are required. Only an explicitly approved call can prepare an OpenAI session. The stream then checks the account, phone call ID, and a per-call random token before attaching audio to that prepared session.
- A selected duration is enforced by both the provider and application. **No time limit** disables Relay's deadline and omits Twilio's per-call `timeLimit`; the provider's account and session limits still apply. A network timeout is treated as uncertain delivery, not permission to retry. Unknown queued calls keep new calls blocked until their status is confirmed. Use the Twilio console if the app cannot confirm disconnection.
- Restart recovery stops an unfinished call; it never redials automatically. The server acquires its ports before recovery so duplicate startup cannot stop the first instance's call.
- “Call ended” is a transport result. An outcome is explicitly labeled model-reported. Missing results remain unconfirmed. Transcript errors can affect summaries, so inspect critical confirmations.
- No audio recordings are saved. Briefs, transcripts, outcomes, and usage are saved locally in ignored `data/calls.json` (owner-only file permissions). OpenAI and Twilio still process their respective request and call data. Stop the server before deleting the data directory to clear local history.
- The first version handles direct human conversations and browser listen-in. No keypad/IVR navigation, transfers, owner takeover, scheduled calls, automatic retries, or custom uploaded files. The assistant is instructed to end on voicemail or menus and request your review; that recognition has not been tested on real calls.
- Audio quality, interruptions, carrier compatibility, voicemail recognition, and spoken goodbye timing require testing in your environment. Automated implementation checks do not establish subjective audio quality.

## Verification

```sh
npm test
npm run check
```

Tests use simulated providers and sockets. They cover preparing voice before dialing, cancellation and failed-call cleanup, duplicate calls, stop/start races, signed callbacks, local-only access, stream identity and codec validation, audio framing, tool deduplication, playback drain, outcome validation, and final usage handling. A simulated minute of phone audio after a two-second voice setup must preserve every byte and add no more than 20 ms of bridge input delay. This measures the local relay, not carrier latency, model response time, audible playback, or conversational success.

## Official references

Integration details were checked on 2026-09-24:

- [GPT-Live 1 model and pricing](https://developers.openai.com/api/docs/models/gpt-live-1)
- [OpenAI telephony connections](https://developers.openai.com/api/docs/guides/voice-sip)
- [GPT-Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets)
- [GPT-Live WebRTC browser connections](https://developers.openai.com/api/docs/guides/voice-webrtc)
- [Server controls for Live sessions](https://developers.openai.com/api/docs/guides/voice-server-controls)
- [Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation)
- [Managing Live sessions](https://developers.openai.com/api/docs/guides/live-conversations)
- [Twilio outbound calls with GPT-Live 1](https://www.twilio.com/en-us/blog/developers/tutorials/integrations/outbound-calls-openai-gpt-live-1-node)
- [Twilio Media Stream messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
- [Twilio's WSS signature validation implementation](https://github.com/twilio/twilio-agent-connect-python/blob/main/src/tac/server/signature_validation.py)

## License

MIT. See [LICENSE](LICENSE).
