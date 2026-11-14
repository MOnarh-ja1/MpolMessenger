# TURN relay for MPOL Messenger calls across different networks

**The MPOL app on Render handles account login, messages and WebSocket signaling.** This relay carries voice/video only when direct WebRTC networking is blocked by NAT or mobile operators. It must run separately on a server capable of accepting UDP/TCP connections with a public IP. It is not deployed by GitHub Pages or the Render HTTP process.

## Setup (Linux VPS with public IPv4)

1. Point a domain like `relay.example.com` to the VPS public IP.
2. Configure real TLS certificates for that domain (the example expects Let's Encrypt under `/etc/letsencrypt`). If you do not have certificates yet, remove TLS config lines and `turns:` URLs temporarily; TLS is recommended for restrictive networks.
3. Copy `turnserver.conf.example` to `turnserver.conf` and replace the example domain and `static-auth-secret` with a long random value. **Never upload the real config/secret to GitHub.** Keep the same secret in the Render environment variable `MPOL_TURN_SECRET`.
4. On the VPS in the `relay` directory, run `docker compose up -d`.
5. In firewall/security group allow TCP+UDP 3478, TCP 5349 (TLS) and relay ports UDP 49160–49250 (adjust to config). Ensure the server has enough bandwidth.
6. In Render MPOL API environment set:
   - `MPOL_TURN_URLS=turn:relay.example.com:3478?transport=udp,turn:relay.example.com:3478?transport=tcp,turns:relay.example.com:5349?transport=tcp`
   - `MPOL_TURN_SECRET=<the SAME private static-auth-secret>`
   - `MPOL_TURN_TTL=3600`
7. Redeploy the API service. Signed-in clients obtain short-lived credentials at `/api/calls/ice`. The reply includes `relayConfigured: true`; do not share returned credentials.
8. Verify a real PC-to-iPhone call with PC on home Wi-Fi and iPhone on mobile data. For best reliability also check TCP/TLS TURN (5349), when UDP is blocked.

If you are using a managed TURN provider, set `MPOL_TURN_URLS`, `MPOL_TURN_USERNAME`, `MPOL_TURN_PASSWORD` in Render instead; never commit provider credentials. This may incur bandwidth costs.

**Limits:** No service can guarantee uninterrupted calls over completely disconnected networks. Both users must have internet and MPOL open. iPhone Safari may pause/close background connections. Incoming calls with Safari completely closed need native push/CallKit and are not implemented.

## Security
- TURN credentials are temporary and authenticated per logged-in MPOL user.
- Only allow relay of required ports; use TLS and provider firewall.
- Do not run an unauthenticated open relay.
- Monitor bandwidth/cost and patch coturn.
