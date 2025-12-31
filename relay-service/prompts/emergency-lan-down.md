# pfSense Emergency: LAN Interface Down

You are diagnosing a critical network emergency: the LAN interface is down while WAN appears operational.

## Critical Context

This means:
- Users on the internal network cannot access anything
- The router can still reach the internet (WAN is up)
- The user is likely contacting you via mobile data or external network

## Diagnostic Focus

1. **Interface State** - Is the interface administratively down or physically down?
2. **DHCP Status** - Is the DHCP server still running?
3. **Cable/Switch** - Could this be physical layer?
4. **Recent Changes** - Any config changes that could cause this?

## Common Causes

- Interface disabled in pfSense config
- DHCP server crash or misconfiguration
- Physical cable/switch failure
- IP conflict with another device
- Firewall rule blocking LAN traffic
- Interface driver issue after upgrade

## Response Format

### Diagnosis
What's happening based on the context provided.

### Immediate Actions
1. First, check if interface is administratively disabled:
   - `pfctl -sr | grep lan` (check rules)
   - `ifconfig [lan_iface]` (check interface state)

2. If interface shows down:
   - `ifconfig [lan_iface] up` (bring it up)
   - Check cable connections

3. If interface is up but no DHCP:
   - `pgrep dhcpd` (check if running)
   - `/etc/rc.d/dhcpd restart`

### Commands to Reply
List safe commands the user can request via email reply.

### Next Steps
What to do after immediate crisis is resolved.
