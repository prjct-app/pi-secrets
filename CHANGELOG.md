## 0.2.6 (2026-10-07)

- Reuse unchanged protocol branches and a bounded cache of clean text across privacy hooks. Every miss is scanned; consent and vault revisions are checked independently.
- Preserve every outbound boundary, cancellation, opaque protocol data and secret rotation. Avoid repeated replacement sorting and consent hashing per text field.

## 0.2.5 (2026-10-07)

- Default to Always obfuscate when no privacy preference exists, including fresh projects and isolated agent homes. Ask remains an explicit TUI choice.
- Show a native Pi `info` when sensitive data is masked, without adding a conversation or model message. Coalesce repeated hooks and retries until the public SDK run settles, and do not notify for unchanged text.
- Cover stored-credential redaction as well as detected PII; preserve encrypted protocol data. Verify default masking, reload, RPC, explicit Ask and cancellation at the SDK HTTP boundary.

## 0.2.4 (2026-10-06)

- Add a persistent **Always obfuscate, never ask** privacy mode, shared across projects, destinations, sessions and reloads. It masks detected data without consent dialogs, masking notices or offers to store pasted credentials.
- Expose the current mode in the Secrets TUI: choose the Privacy row with Enter or press `p`. Choose Ask to disable automatic mode. Add `/secret privacy`, `/secret privacy always` and `/secret privacy ask`.
- Keep stored-credential redaction and encrypted provider protocol intact. Save only the mode in a private settings file; retain SDK session consent in Ask mode.

## 0.2.3 (2026-10-06)

- Serialize concurrent privacy checks so one detected value triggers one consent dialog. A cancelled dialog also cancels already queued checks.
- Remember choices through the public SDK session store across extension reloads, without storing raw detected values. Add `/secret privacy reset` to revoke them.
- Offer automatic obfuscation for the current session and destination; reduce background masking notices to one per loaded session.
- Stop detecting npm package versions as email addresses. Keep stored-credential redaction and opaque provider protocol preservation.

## 0.2.2

- Preserve provider item IDs, signed thinking and encrypted reasoning byte for byte in both secret and PII guards.
- Do not classify or replace digit runs inside protocol identifiers as payment cards.
- Regression coverage reproduces the encrypted item ID corruption while confirming real PII and stored secrets stay masked.

## 0.2.1 (2026-10-06)

- Share background keychain reads per vault revision, including denied reads; stop retrying blocked reads on every hook.
- Keep outbound protection closed on a keychain failure and allow an explicit `/secret` retry.
- Scan long source-code tokens in linear time without losing adjacent PII detection.
- Isolate SDK tests from personal credentials and prohibit native keychain access.

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
