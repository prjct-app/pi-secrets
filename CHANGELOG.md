## 0.2.0 (2026-10-06)

- Add local outbound privacy detection with explicit send, obfuscate and cancel choices.
- Protect SDK context and provider payloads; export a guard for direct background SDK calls.
- Declining keychain storage no longer implicitly permits sending a credential.

# Changelog

## 0.1.2

### Fixes

* Accept secrets from four characters, including short PINs and six-digit OTPs.
* Redact short values and encoded forms with the same minimum as the masked prompt.
* Preserve complete secret forms across streamed output boundaries, including padded base64.

## 0.1.0 (unreleased)

### Features

* Secrets stored in the OS keychain through a masked prompt; the index keeps names, scopes and dates only.
* `secret_list` and `secret_request`: agents get secrets by name and ask for missing ones through the terminal, never the chat.
* Bash commands that mention a name get its value through a one-shot private file; the model's command is kept as written.
* Every form of every value is redacted from tool results, `!` commands, and the model context.
* Stored values typed into the editor are hidden; credential-shaped pastes are offered to the keychain.
* `/secret` panel: new, replace, delete, per-project scope, and the last six characters.
