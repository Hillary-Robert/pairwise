# Pairwise relay

Lets the phone and computer reach each other when they're on different networks. Both
connect *out* to the relay, so no port forwarding is needed at home.

The relay only pipes encrypted bytes. It never has a key, can't read clipboard, files or
notifications, and stores nothing. Rooms are named by an HMAC of the device key, so the
relay can't tell which devices are talking.

## Run it on a small VPS

1. Point a domain at the server (for example `relay.example.com`) and get a certificate:
   `sudo certbot certonly --standalone -d relay.example.com`
2. Build and start it:

   ```bash
   docker build -f apps/relay/Dockerfile -t pairwise-relay .
   docker run -d --restart=always -p 443:9443 \
     -v /etc/letsencrypt:/etc/letsencrypt:ro pairwise-relay \
     --tls-cert /etc/letsencrypt/live/relay.example.com/fullchain.pem \
     --tls-key  /etc/letsencrypt/live/relay.example.com/privkey.pem
   ```

3. In the desktop app: **Settings > Relay**, enter `tls://relay.example.com:443`, then pair (or re-pair) the phone.

Without Docker: `npm install && npm run build -w @pairwise/core -w @pairwise/relay`, then
`node apps/relay/dist/main.js --port 443 --tls-cert … --tls-key …`.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--port` | 9443 | Port to listen on |
| `--host` | all | Address to bind |
| `--tls-cert`, `--tls-key` | none | PEM files; required unless `--insecure` |
| `--insecure` | off | Plain TCP, for testing or behind a TCP-level TLS proxy |
| `--max-rooms` | 20000 | Desktops that may wait at once |
| `--max-per-ip` | 64 | Connections per client IP |

Each flag also works as an environment variable: `PAIRWISE_PORT`, `PAIRWISE_TLS_CERT`, and so on.

## Costs and limits

Traffic through the relay counts against the server's bandwidth. Big files go faster on the
same Wi-Fi, where the relay isn't used. Idle pipes close after 10 minutes without traffic
(the phone pings every 20 seconds while connected).
