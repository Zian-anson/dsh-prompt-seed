# Security

## Reporting a vulnerability

Please report privately through GitHub's
[security advisory](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/adding-a-security-policy-to-your-repository)
form rather than in a public issue, and avoid posting a working proof of concept publicly until a
fix is available.

## What this plugin touches

Worth knowing before you assess a report:

- **It holds no credentials.** It calls the host's `llm` service; model access and API keys remain
  the host's responsibility. There is no key in the source, the config, or the browser bundle.
- **It opens exactly one HTTP route**, `POST /api/prompt-seed/optimize`, and only on loopback. The
  handler checks the peer socket address **and** the `Host` header, so a page performing DNS
  rebinding cannot reach it. Business outcomes are returned as `200` with the outcome in the body;
  only a non-loopback caller gets `403`.
- **It reads session history** through the host's `sessionQuery.readSurface`, on demand, and uses it
  only to resolve references.
- **It writes one local file**, `$DSH_HOME/prompt-seed/samples.jsonl`, appending the outcome of each
  run plus the first 400 characters of the input. `samples: false` disables it.
- **The browser half stores four counters** in `localStorage` for depth adaptation. Nothing is
  uploaded.

Out of scope, because they are the host's design rather than this plugin's: anything reachable by
other plugins running in the same process (the host does not sandbox plugin code), and the model
provider's own handling of the text you send it.

## Supported versions

The latest `0.x` minor receives fixes. The plugin declares `engines.dsh` and self-disables on hosts
outside that range rather than failing the host's boot.
