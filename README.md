# System Monitor Dashboard

A lightweight Node.js + Express + Socket.IO dashboard for monitoring multiple servers in real time. It focuses on the essentials: CPU, RAM, disk usage, and network throughput, plus optional host info.


![Screenshot](https://res.cloudinary.com/dhqcnszvn/image/upload/v1771362834/Screenshot_2026-02-18_024116_mlq0zt.png)


## Features

- Real-time metrics over Socket.IO
- Offline detection when agents stop reporting
- Lightweight, static frontend (no frameworks)
- Optional system info panel per server (hostname, OS, CPU model, totals)

## Architecture

- **Dashboard** (this repo): Express + Socket.IO server with a static frontend in `public/`
- **Agent**: Collects metrics and reports to the dashboard

Agent repo:
- https://github.com/SathiraSriSathsara/system-monitoring-agent

## Requirements

- Node.js 18+ (recommended)
- npm

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure environment:

   Copy `sample.env` to `.env` and update values as needed.

3. Start the server:

   ```bash
   npm start
   ```

   For production use, run with a process manager like PM2.

## Agent Setup

1. Clone the agent repo on each server you want to monitor.
2. Run the agent setup script and provide the dashboard URL and API key (if configured).
3. Start the agent service.

Once the agent is running, servers will appear automatically in the dashboard.

## API

- `GET /api/latest`
  - Returns the latest metrics for all servers.

Example response:

```json
{
  "ok": true,
  "data": [
    {
      "server_id": "server-1",
      "ts": 1739898302,
      "cpu": 23.5,
      "ram": 61.2,
      "disk": 47.8,
      "net_rx_bps": 15234.12,
      "net_tx_bps": 8234.55,
      "online": true,
      "last_seen_seconds": 3,
      "info": {
        "hostname": "vps-01",
        "os": "Ubuntu 22.04.4 LTS",
        "cpu_model": "Intel Xeon E5-2680 v4",
        "cpu_cores": 8,
        "ram_total_mb": 16384,
        "disk_total_gb": 200
      }
    }
  ]
}
```

## Project Structure

```
public/          # Frontend dashboard
server.js        # Express + Socket.IO server
sample.env       # Example environment file
```

## Notes

- The dashboard UI shows servers as offline when no updates arrive within a configurable threshold.
- The WebSocket connection status indicates dashboard connectivity only, not server health.

## License

MIT
