# Security Policy

## Supported versions

| Version | Support status |
| --- | --- |
| `main` and the latest stable release | Supported for security reports |
| Older releases | Best effort only; upgrade before reporting a regression |

The desktop release and source tree can contain different fixes. Include the exact app version, release tag, or commit when reporting a problem.

## Reporting a vulnerability

Please do **not** report security vulnerabilities in a public GitHub Issue, Discussion, or pull request.

Use [GitHub Private Vulnerability Reporting](https://github.com/Logosss1/Edict_InnerCourt/security/advisories/new) when it is available. If private reporting is unavailable, contact the repository maintainer through the GitHub profile and do not include exploit details in a public message.

A useful report should include:

- the affected version, macOS version, and CPU architecture;
- the vulnerability type and affected component or file;
- clear reproduction steps or a minimal proof of concept;
- the expected and observed behavior;
- a practical impact assessment;
- suggested mitigation, if known.

Remove API keys, provider URLs containing credentials, cookies, OpenClaw user data, private attachments, and identifying logs before sending a report. If the issue requires a log, provide the smallest redacted excerpt that demonstrates the problem.

## Disclosure process

Maintainers will acknowledge a private report when possible, reproduce and assess its impact, coordinate a fix or mitigation, and publish a release note after the fix is available. Reporters may remain anonymous.

We follow responsible disclosure: please allow time for assessment and remediation before publicly describing an unresolved vulnerability.

## Security boundaries

- Provider and dispatch-channel secrets configured in the desktop app are stored separately from ordinary metadata and are not intended to be committed to Git.
- OpenClaw channel configuration managed by the desktop app uses environment-backed SecretRefs rather than plaintext secret values in the generated configuration.
- Application user data, credentials, attachments, and runtime logs are local per-install data and must never be copied into a source checkout or Release asset.
- Keep the local dashboard on its intended loopback boundary. If you expose it through a proxy or network interface, add authentication, authorization, HTTPS, and network restrictions appropriate to your environment.
- The distributed macOS application is currently unsigned and not notarized. Verify Release provenance before opening it and follow macOS Gatekeeper guidance rather than bypassing security controls blindly.

## Maintainer checklist

Before publishing a release:

1. Run the source and UI test suites.
2. Inspect the staged diff for credentials and personal data.
3. Confirm that generated user data and runtime caches are ignored.
4. Verify that the Release contains only intended architecture-specific packages and public documentation.
5. Record security-relevant changes in the Release description.
