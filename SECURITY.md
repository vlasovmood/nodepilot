# Security

NodePilot stores access credentials for your servers and runs commands on them, so we take vulnerabilities seriously.

## Supported versions

Security fixes are released for the latest minor version. You can update from the panel:
**Settings → Updates**.

## Reporting a vulnerability

**Do not open a public issue.** Report it privately through
[Security → Report a vulnerability](https://github.com/vlasovmood/nodepilot/security/advisories/new) (GitHub Private Vulnerability Reporting).

Please include:
- the version and how it is installed (systemd, Docker);
- a description and the impact (what an attacker can do);
- steps to reproduce or a PoC;
- any known workarounds.

We will acknowledge your report within 3 business days, share our assessment and a fix plan within 10 days, and
agree on a disclosure date with you. If you wish, we will credit you in the release notes.

### In scope

- Bypassing authentication, 2FA or API token permissions; privilege escalation.
- Leaking secrets (passwords, keys, S3 tokens, backup passphrases, the master key) through the API, MCP, the audit
  log, logs or the UI.
- Command injection on managed servers, bypassing SSH host key verification, bypassing `authorized_keys` restrictions.
- XSS, CSRF and similar issues in the web UI.
- Update tampering (bypassing the SHA-256 or signature check).

Out of scope: denial of service through request volume; vulnerabilities in third-party dependencies that don't
affect NodePilot (please report those to their authors).

## Threat model: what if the panel server is compromised

You cannot fully protect against an attacker with root on a **running** panel server: the panel needs keys to reach
your servers, and while it runs, those keys are in its memory. NodePilot aims for the following instead:

| Threat | Protection |
|---|---|
| A stolen disk, VM snapshot or backup of `/var/lib/nodepilot` | Secrets in the database are encrypted with the master key, and the key itself is sealed in the TPM (`seal-master-key.sh`). They cannot be decrypted without this machine |
| A stolen panel SSH key | Servers accept the key only from the panel's addresses (`from=` in `authorized_keys`), with port and agent forwarding disabled. It is useless from any other machine |
| Stolen backup archives | Archives are encrypted to an age public key. Only you hold the private key; the panel itself cannot decrypt them |
| An attacker acting through the panel | An audit log of every change, command, AI call and login, forwarded to syslog or a webhook, so the trail can't be erased on the panel server |
| Access must be cut off immediately | Rotate or emergency-revoke the panel key on all servers with one click, or without the panel at all (see below) |
| Password guessing, a stolen password | 2FA (TOTP), a lockout after 5 failed attempts per IP and per username, Argon2id hashes |

## Recommended setup

1. **HTTPS and restricted access.** The panel listens on `127.0.0.1`. Expose it only through a reverse proxy with TLS,
   preferably behind a VPN/WireGuard. Set `NODEPILOT_SECURE_COOKIES=true`. If the proxy runs on another host, list it in
   `NODEPILOT_TRUSTED_PROXIES` so the login lockout sees real client addresses.
2. **2FA** for every user: **Security → Two-factor authentication**. Store the recovery codes separately.
   If a user loses both the phone and the codes, run this on the panel server:
   `sudo nodepilot user reset-2fa <user> --data-dir /var/lib/nodepilot` (with a TPM-sealed key, `sudo` is required).
3. **Master key in the TPM** (Ubuntu 24.04+, Debian 12+, systemd 250+; enable vTPM in a VM):
   ```sh
   sudo ./packaging/seal-master-key.sh --backup-to /root/nodepilot-master.key.backup
   # then move the copy off the server (password manager, offline storage) and delete it here
   ```
   The script seals the key (`systemd-creds encrypt --with-key=tpm2`), checks that it decrypts, attaches it to the
   service (`LoadCredentialEncrypted=`), restarts the panel, and only then deletes the plaintext copy.
   The panel refuses to start with a wrong key and never creates a new key over existing data.
   To move the key back to a file (for example, before migrating): `sudo ./packaging/seal-master-key.sh --unseal`.
   In Docker, use Docker secrets and `NODEPILOT_MASTER_KEY_FILE=/run/secrets/nodepilot_master_key`.
4. **Use the panel key instead of passwords and personal keys:** **Security → Panel SSH key**. Enter the panel's
   addresses (the **Detect** button shows the address the server sees), install the key on your servers and switch
   them to it. You can then disable password login on the servers (`PasswordAuthentication no`).
5. **Encrypt backups to an age public key.** You can generate a key pair in the panel (the private key is shown once
   and never stored) or with `age-keygen -o key.txt`. To decrypt: `age -d -i key.txt archive.age > archive`.
6. **Forward the audit log off the server:** **Security → Audit log forwarding**. Use syslog (`udp://` / `tcp://`) or
   a webhook signed with `X-NodePilot-Signature: sha256=<HMAC of the body>`. Set up alerts for `critical` events.
7. **API tokens:** give them the minimum permissions and an expiry date. Don't give AI tokens `admin`, and avoid
   `exec` where possible.
8. **On the servers:** use a dedicated user for the panel, with `sudo` limited to the commands it needs, instead of
   `root`.
9. **Keep an offline copy** of `master.key`, separate from the database backups.

## Emergency revocation without the panel

Every panel key line in `authorized_keys` is tagged with the comment `nodepilot-panel-key:<id>`. If the panel server
is compromised and you can't reach it, remove the panel keys from all servers with your own tooling, for example:

```sh
ansible all -b -m shell -a "sed -i.bak '/nodepilot-panel-key:/d' ~/.ssh/authorized_keys"
```

Run it as the user the panel connects with (with `-b`, set `-u` or `become_user` accordingly).
Then change the passwords that were stored in the panel, the S3 keys, and any API tokens of external systems.
