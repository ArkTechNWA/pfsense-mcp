# pfSense Emergency Relay

Passive relay service that receives emergency webhooks from pfSense, runs Claude diagnostics using the user's API key, and sends alerts.

## Principles

- **Passive**: Never initiates connections to pfSense
- **User's Key**: Each device uses their own Anthropic API key
- **Self-Hostable**: Works at pfsense-mcp.arktechnwa.com or run your own
- **Ephemeral**: All data expires after 24 hours

## Quick Start

### Deploy Your Own

```bash
docker run -d \
  -e SMTP_HOST=smtp.example.com \
  -e SMTP_USER=you@example.com \
  -e SMTP_PASS=secret \
  -e RELAY_SECRET=your-secret-key \
  -p 443:3000 \
  arktechnwa/pfsense-emergency-relay
```

### Use Public Relay

1. Install the tiny client on your pfSense:
   ```sh
   fetch -o /usr/local/bin/pfsense-relay https://pfsense-mcp.arktechnwa.com/pfsense-relay.sh
   chmod +x /usr/local/bin/pfsense-relay
   pfsense-relay init
   ```

2. Register at: https://pfsense-mcp.arktechnwa.com/register

3. Add cron job:
   ```
   */5 * * * * /usr/local/bin/pfsense-relay check
   ```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/emergency` | POST | Receive alerts from pfSense |
| `/checkin` | POST | pfSense picks up pending commands |
| `/report` | POST | pfSense reports status |
| `/register` | GET/POST | Device registration |
| `/health` | GET | Service health check |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | HTTP port |
| `HOST` | 0.0.0.0 | Bind address |
| `RELAY_SECRET` | (required) | Secret for API key encryption |
| `SMTP_HOST` | localhost | SMTP server |
| `SMTP_PORT` | 587 | SMTP port |
| `SMTP_USER` | - | SMTP username |
| `SMTP_PASS` | - | SMTP password |
| `SMTP_FROM` | relay@... | From address |
| `RELAY_DOMAIN` | pfsense-mcp.arktechnwa.com | Reply-to domain |

## Email Commands

Reply to alert emails with commands:

- `restart dhcp` - Restart DHCP service
- `restart dns` - Restart DNS resolver
- `status` - Get current status
- `help` - List available commands

Commands are queued and executed on next pfSense check-in.

## Security

- API keys encrypted at rest with RELAY_SECRET + device token
- Webhook signatures verified with HMAC-SHA256
- Timestamp replay protection (5 minute window)
- All data expires after 24 hours
- Email reply commands are allowlisted

## Development

```bash
npm install
npm run build
npm run dev
```

## License

MIT
