# pi-secrets

Give Pi agents your API keys without putting them in the conversation.

A key is typed once into a masked prompt and goes straight to the OS keychain. Agents only ever know its name: a bash command that mentions `STRIPE_SECRET_KEY` runs with `$STRIPE_SECRET_KEY` set, and anything that prints the value shows `[secret:STRIPE_SECRET_KEY]` instead. The value never reaches the model, the session file, or the transcript, so using a key with an agent is no reason to rotate it.

## Install

Requires Pi **0.85.1** and Node.js **22.19+**.

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

Names are environment variable names: `A–Z`, digits and `_`, starting with a letter. `PATH`, `HOME` and similar shell names, and anything starting with `PI_`, are refused. Values need at least 8 characters, so hiding them never blanks out ordinary words.

## What keeps the value out

- **Storage.** Values live only in the macOS Keychain (Secret Service on Linux, Credential Manager on Windows), under the service `app.prjct.pi-secrets`. `${PRJCT_HOME:-~/.prjct}/pi-secrets/index.json` (mode 0600) holds names, scopes and dates, never a value or any part of one.
- **Injection by mention.** Only a bash command that mentions a name as a whole word gets that variable, and only if the secret is given to the current project. Nothing else inherits it. The values reach the shell through a one-shot file (mode 0600, in a 0700 per-user folder) that the shell deletes as soon as it reads it, so they never appear on a command line (`ps`), and the command the model wrote is what the session and the UI keep. A name the project was not given is left unset, and the agent is told to call `secret_request`.
- **Redaction.** Every form of every stored value (as typed, JSON-escaped, URL-encoded, base64 standard, unpadded or URL-safe) is replaced by `[secret:NAME]` in every tool result, including the full output file of a truncated bash run, in your `!` commands (the stream is redacted before it is shown), and in every message sent to the model. A value replaced or deleted during a session stays hidden for the rest of it.
- **Your own messages.** A stored value typed into the editor is replaced before sending. A credential with a known shape (Anthropic, OpenAI, OpenRouter, Stripe, GitHub, GitLab, Slack, AWS, Google, npm, Hugging Face, Resend, PEM private keys) triggers an offer to store it instead; accept and the message goes out with `[secret:NAME]`.

## What it does not do

This stops a key from leaking by accident: into the transcript, the provider, logs, or a screen share. It is not a sandbox. An agent that means to leak a key can still send it to another host with `curl`, or print it transformed (reversed, split, inside a larger base64 blob) where redaction cannot recognize it. Run untrusted work in a container with only the keys it needs; see Pi's [security notes](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/security.md).

## Development

```sh
npm run check
npm test
npm run build:pi
```

Tests use an in-memory key store and never touch the real keychain.
