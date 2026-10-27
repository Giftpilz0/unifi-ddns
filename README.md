# unifi-ddns

[![ci](https://github.com/Giftpilz0/unifi-ddns/actions/workflows/ci.yml/badge.svg)](https://github.com/Giftpilz0/unifi-ddns/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Cloudflare Worker that lets UniFi OS keep A/AAAA records on Cloudflare up to date. A rewrite of
[willswire/unifi-ddns](https://github.com/willswire/unifi-ddns) with the same API.

## Usage

1. Create a **User** API token (Profile → API Tokens, template _Edit zone DNS_) scoped to **one** zone.
1. Create the DNS records in Cloudflare; the worker only updates existing ones.
1. In UniFi: Settings → Internet → WAN → Dynamic DNS:
   - Service: `custom`
   - Hostname: `home.example.com` (comma-separated for several)
   - Username: your Cloudflare email (not used, but required by UniFi)
   - Password: the API token
   - Server: `unifi-ddns.<subdomain>.workers.dev/update?ip=%i&hostname=%h` (without `https://`)

| Parameter    | Meaning                                                   |
| ------------ | --------------------------------------------------------- |
| `ip`, `myip` | New address (A or AAAA); `auto` uses the caller's address |
| `ip6`        | Additional AAAA address for every hostname                |
| `hostname`   | Record name(s), comma-separated                           |

The path is ignored. Proxy status, comments and tags are kept; the TTL is set to auto.
Test it with:

```sh
curl -u "you@example.com:<token>" "https://unifi-ddns.<subdomain>.workers.dev/update?ip=auto&hostname=home.example.com"
```

Logs: Cloudflare dashboard → Workers → `unifi-ddns` → Logs.

## Development

`just dev` runs the worker locally. Cloudflare Workers Builds deploys every push to `main`.
Run `just` for all recipes and `just check` before committing. Conventions: [Giftpilz0/shared](https://github.com/Giftpilz0/shared).

## License

[MIT](LICENSE)
