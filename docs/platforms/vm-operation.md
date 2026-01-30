# VM Operation Guide

This guide covers operating a source-built Moltbot instance on a Linux VM with systemd.

## Key Paths

| Purpose | Path |
|---------|------|
| Config file | `~/.config/moltbot/moltbot.json` |
| Systemd service | `~/.config/systemd/user/moltbot-gateway.service` |
| Logs | `journalctl --user -u moltbot-gateway` |

## Building from Source

```bash
cd <source-directory>

# Install dependencies
pnpm install

# Build
pnpm build

# Restart gateway to apply changes
systemctl --user restart moltbot-gateway
```

## Service Management (systemd)

```bash
# Check status
systemctl --user status moltbot-gateway

# Start
systemctl --user start moltbot-gateway

# Stop
systemctl --user stop moltbot-gateway

# Restart
systemctl --user restart moltbot-gateway

# Enable auto-start on boot
systemctl --user enable moltbot-gateway
```

## Viewing Logs

```bash
# Real-time follow (clean format, recommended)
journalctl --user -u moltbot-gateway -f -o cat

# Last 100 lines
journalctl --user -u moltbot-gateway -n 100 -o cat

# Today's logs
journalctl --user -u moltbot-gateway --since today -o cat

# Full systemd metadata
journalctl --user -u moltbot-gateway -f
```

The `-o cat` flag removes systemd prefixes (timestamp, hostname, process ID), showing only the application log output.

## TUI (Terminal UI)

```bash
cd <source-directory>

# Start TUI (connects to running gateway)
pnpm tui
```

## Configuration

Main config: `~/.config/moltbot/moltbot.json`

```bash
# View config
cat ~/.config/moltbot/moltbot.json

# Edit config (restart required after changes)
nano ~/.config/moltbot/moltbot.json
systemctl --user restart moltbot-gateway
```

## Quick Reference

```bash
# Check gateway process
ps aux | grep moltbot-gateway

# Check port
ss -tlnp | grep 3000

# Full rebuild and deploy
cd <source-directory> && pnpm build && systemctl --user restart moltbot-gateway
```

## Troubleshooting

### Gateway Won't Start

```bash
# Check detailed errors
journalctl --user -u moltbot-gateway -n 50 -o cat

# Run manually to see errors
cd <source-directory>
node dist/index.js gateway --port 3000
```

### Build Failures

```bash
cd <source-directory>
pnpm install  # Reinstall dependencies
pnpm build    # Rebuild
```
