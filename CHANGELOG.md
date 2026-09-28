# Changelog

## 0.1.0 (unreleased)

### Features

* Secrets stored in the OS keychain through a masked prompt; the index keeps names, scopes and dates only.
* `secret_list` and `secret_request`: agents get secrets by name and ask for missing ones through the terminal, never the chat.
* Bash commands that mention a name get its value through a one-shot private file; the model's command is kept as written.
* Every form of every value is redacted from tool results, `!` commands, and the model context.
* Stored values typed into the editor are hidden; credential-shaped pastes are offered to the keychain.
* `/secret` panel: new, replace, delete, per-project scope, and the last six characters.
