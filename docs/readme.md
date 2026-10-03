# Project documentation

This repository contains the canonical agent rules and the personal OpenCode
plugins. See [the root README](../README.md) for installation and the plugin list.

The plugins are TypeScript modules loaded by OpenCode; the plugin manager serves
their settings dashboard locally. Session Manager reads the OpenCode SQLite
database and external agent stores. Portable archives retain session records
and revisions for merging into another device's database.
Directory synchronization uses per-project, per-session JSON revisions instead
of archives, with Manual, Local only, Directory and Auto modes.

See [session archive transfer](development/session-archives.md) for the device
transfer workflow, format scope, and isolated verification commands.
