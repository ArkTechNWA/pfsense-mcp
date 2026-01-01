# Lost Gorgeous Dashboard - Recovery Spec

## What Meldrey Described (GOLDEN TREASURE)

### Layout
- Full-width header stretching across screen
- Inline cartouches - one per device, horizontal flow
- Multiple devices = multiple inline cartouches

### System Card
- 3 progress bars (CPU, Memory, Disk)
- **Green to blue gradients** - strong and subtle at once
- **Histogram UNDER each bar** - showing history

### Visual Style
- Large cards, not cramped
- Color gradients that TRACKED values
- "Airline histograms" style

---

## Search Locations (EXHAUSTED)

- [x] VPS: /var/www/pfsense-mcp.arktechnwa.com/ - NO backups
- [x] VPS: /home/claude/ - NO dashboard files
- [x] VPS: /tmp/ - found dashboard-fix.js, dashboard-patch.js (basic versions, NOT gorgeous)
- [x] VPS: vim/nano swap files (.swp, .swo, ~) - NONE
- [x] VPS: grep for "gradient", "histogram" - NOT in pfsense-mcp area
- [x] Local: find dashboard files - NONE relevant
- [x] Local: grep for gradient patterns - NONE
- [x] Git: stash list - EMPTY
- [x] Git: dangling/unreachable commits - NONE
- [x] Git: lost-found - EMPTY

---

## VERDICT: Gorgeous dashboard is TRULY LOST

Never committed to git. No backups anywhere. Must rebuild from spec above.

## Recovery Priority: REBUILD from Meldrey's description
