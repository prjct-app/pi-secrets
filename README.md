# pi-secrets

[![pi-secrets — for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-secrets/main/docs/cover.png)](https://pi.dev)

Give Pi agents your API keys without putting them in the conversation.

A key is typed once into a masked prompt and goes straight to the OS keychain. Agents only ever know its name: a bash command that mentions `STRIPE_SECRET_KEY` runs with `$STRIPE_SECRET_KEY` set, and anything that prints the value shows `[secret:STRIPE_SECRET_KEY]` instead. Stored values are redacted from the model context, tool results and transcript. This is a local guardrail, not a sandbox for arbitrary code or network traffic.

## Install

Requires Pi **1.0.3** and Node.js **22.19+**.

```sh
pi install npm:@prjct.app/pi-secrets
```

## How agents get a key

The agent asks; you answer in the terminal, not in the chat.

1. The agent calls `secret_list` to see which names exist here.
2. For a missing one it calls `secret_request { name, reason }`. A masked prompt opens with the reason; you paste the value and choose **Only this project** or **Every project**.
3. The agent gets back `STRIPE_SECRET_KEY stored. Use it as $STRIPE_SECRET_KEY in bash.`, and writes commands like:

```sh
curl https://api.stripe.com/v1/charges -u "$STRIPE_SECRET_KEY:"
```

The tool guidelines tell the agent never to ask for a credential in chat, never to print one, and to use `secret_request` instead. Declining the prompt tells the agent to continue without the key or stop, not to ask again in chat.

Every Pi on the machine reads the same keychain, so teammates in [pi-team](https://github.com/prjct-app/pi-team) and subagents get a key by name without anyone copying it.

## Managing secrets

`/secret` opens the shared docked panel: every secret, whether it is available in this project (● or ○), and its last six characters (`••••KlMnOp`, fewer for a short value). The model never sees those characters, only you do.

| Key | Action |
| --- | --- |
| `n` | New secret: name, then the masked value, then where agents may use it |
| `p` | Privacy settings: always obfuscate without asking, or ask before sending |
| `r` | Replace the value; the name and scope stay, so agents keep working |
| `a` | Give the secret to this project, or take it away |
| `g` | Switch between every project and only this one |
| `x` | Delete it from the keychain (press again to confirm) |

| Command | Meaning |
| --- | --- |
| `/secret` | The panel. In print and RPC modes, the list as text. |
| `/secret set NAME [about]` | Store or replace a secret through the masked prompt. |
| `/secret remove NAME` | Delete a secret after a confirmation. |
| `/secret list` | Names, last six characters and scope. |
| `/secret privacy` | Choose a persistent privacy mode in the TUI. Also available in the panel's **Privacy / Privacidad** row with Enter or `p`. |
| `/secret privacy always` | Default: obfuscate detected sensitive data without dialogs or storage offers; a native Pi info notice counts what was hidden. |
| `/secret privacy ask` | Turn off automatic mode and ask before sending detected sensitive data. Clears this session's previous choices. |
| `/secret privacy reset` | Forget this session's choices while keeping the persistent mode. |

Names are environment variable names: `A–Z`, digits and `_`, starting with a letter. `PATH`, `HOME` and similar shell names, and anything starting with `PI_`, are refused. Values need at least 4 characters, including short PINs and six-digit OTPs. Short values can also hide matching ordinary text in outputs.

## What keeps the value out

- **Storage.** Values live only in the macOS Keychain (Secret Service on Linux, Credential Manager on Windows), under the service `app.prjct.pi-secrets`. `${PRJCT_HOME:-~/.prjct}/pi-secrets/index.json` (mode 0600) holds names, scopes and dates, never a value or any part of one.
- **Injection by mention.** Only a bash command that mentions a name as a whole word gets that variable, and only if the secret is given to the current project. Nothing else inherits it. The values reach the shell through a one-shot file (mode 0600, in a 0700 per-user folder) that the shell deletes as soon as it reads it, so they never appear on a command line (`ps`), and the command the model wrote is what the session and the UI keep. A name the project was not given is left unset, and the agent is told to call `secret_request`.
- **Redaction.** Every form of every stored value (as typed, JSON-escaped, URL-encoded, base64 standard, unpadded or URL-safe) is replaced by `[secret:NAME]` in every tool result, including the full output file of a truncated bash run, in your `!` commands (the stream is redacted before it is shown), and in every message sent to the model. A value replaced or deleted during a session stays hidden for the rest of it.
- **Your own messages.** A stored value typed into the editor is replaced before sending. A credential with a known shape (Anthropic, OpenAI, Stripe, GitHub, GitLab, Slack, AWS, Google, npm, Hugging Face, Resend, PEM private keys) triggers an offer to store it instead; accept and the message goes out with `[secret:NAME]`.

## What it does not do

This stops a key from leaking by accident: into the transcript, the provider, logs, or a screen share. It is not a sandbox. An agent that means to leak a key can still send it to another host with `curl`, or print it transformed (reversed, split, inside a larger base64 blob) where redaction cannot recognize it. Run untrusted work in a container with only the keys it needs; see Pi's [security notes](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/security.md).

## Development

```sh
npm run check
npm test
npm run build:pi
```

Tests use an in-memory key store and never touch the real keychain.

## Outbound privacy guard

Before sending text to the selected model, pi-secrets detects email addresses, international phone numbers, Luhn-valid payment-card numbers in common formats, and the credential formats listed above. Detection runs locally. No classifier service receives the data.

**Always obfuscate, never ask / Ofuscar siempre, sin preguntar** is the default. It applies to every project, model, endpoint and session, survives reloads and restarts, and overrides earlier session choices to send detected values unchanged. It masks detected PII and pasted credentials without confirmation or offers to store the pasted credential. When data is masked, a native Pi `info` notice says what was hidden, counted by category: for example **Secrets obfuscated before sending to the model: 1 stored secret, 2 emails, 1 payment card.** Categories are stored secrets, credentials (shaped tokens and keys), emails, payment cards and phone numbers; distinct values are counted, and only their hashes are kept. The notice uses the language the person last typed (Spanish or English, English by default): **Secrets ofuscó antes de enviar al modelo: 2 correos.** It is never inserted into the conversation or model context. Repeated hooks, retries and tool continuations share one notice; if new values are masked later in the same run, one more notice with the totals appears when the SDK run settles. Clean data does not trigger a notice. Existing stored secrets remain redacted. Explicit commands to store or request a needed credential still open their intended prompts.

To change the mode, open `/secret`, select the **Privacy / Privacidad** row with Enter or press `p`. Choose **Ask before sending / Preguntar antes de enviar** to enable consent dialogs explicitly, or choose **Always obfuscate** to disable them. Existing explicit Ask preferences are respected. Only the mode is saved in `${PRJCT_HOME:-~/.prjct}/pi-secrets/privacy.json` (mode 0600); no detected data or credential is written there. A missing preference defaults to Always. Other running Pi processes read the preference at their next outbound inspection; use `/reload` after installing an extension update to load its new behavior.

In Ask mode, the terminal shows a masked preview such as `p**********@****.com` and four choices:

- **Obfuscate / Ofuscar** sends the masked text.
- **Send original / Enviar original** explicitly permits these detected values for this model and endpoint in this session.
- **Cancel / Cancelar**, including dismissing the dialog, stops the request.
- **Automatically obfuscate for this session / Ofuscar automáticamente en esta sesión** masks current and future detected values for this model and endpoint without another dialog. It also overrides earlier choices to send a value unchanged. Other destinations still require their own choice.

Decisions are saved as salted fingerprints in private SDK session entries, without copying the detected values. They survive an extension reload or resuming the same session; a new session or a branch without those decisions starts fresh. Concurrent inspections of the same value share one dialog, and cancelling it also cancels already queued inspections. Run `/secret privacy reset` to forget the session's choices. Package versions such as `typebox@1.3.7` are not treated as email addresses.

Stored keychain secrets are always redacted, even after authorizing PII. Declining an offer to store an unknown credential opens the privacy decision; it no longer implies permission to send it. Explicitly sending an unstored credential may expose it to both the model and session history.

Coverage includes interactive input, outbound history and tool text, restored system instructions, and the SDK `before_provider_request` payload. Print/RPC/background sessions cannot obtain interactive consent, so newly detected data is masked automatically. The extension uses the public SDK notification channel for masking info; it never adds a chat message. The standalone background helper has no UI and masks silently. A failed confirmation or inaccessible keychain cancels sending. Privacy notices never include the original detected value.

Masking outbound context does not erase source files, previous session entries or tool output on disk. Images, binary attachments, encrypted reasoning, arbitrary encodings, names and addresses without recognizable patterns are outside this detector. Models and extensions can reconstruct information from surrounding context; masking is not anonymization. Other extensions must respect the SDK payload hook; independent HTTP calls cannot be intercepted by a Pi extension.

For extensions making direct public SDK calls outside a session, declare `@prjct.app/pi-secrets` in `dependencies` and use the exported guard before the call:

```ts
import { protectOutboundData } from '@prjct.app/pi-secrets/privacy';
const context = await protectOutboundData(originalContext);
const result = await runtime.completeSimple(model, context, options);
```

This background helper masks detected PII and known keychain values without sending anything to a classifier. It throws if an indexed credential cannot be read, so the caller must not retry with the unprotected data.

Background SDK guards reuse one in-memory keychain snapshot until the vault index changes. A denied read stays blocked instead of prompting on every request; use `/secret` to explicitly retry. No credential cache is written to disk.

Tests run with temporary Pi and prjct directories. Importing the native keychain in the test process fails immediately; credential fixtures use an in-memory `KeyStore`.
