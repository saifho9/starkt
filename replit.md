# Discord Ticket Dashboard Bot

A Discord bot with a web dashboard for managing ticket panels and staff stats.

## Stack

- **Runtime**: Node.js 20 (ESM)
- **Discord**: discord.js v14
- **Database**: MongoDB (via Mongoose)
- **Web server**: Express (dashboard UI + REST API)

## How to run

```
node index.js
```

The app starts on port 5000. It connects to MongoDB and logs into Discord, then serves the web dashboard.

## Required secrets

| Secret | Description |
|--------|-------------|
| `DISCORD_TOKEN` | Discord bot token |
| `MONGO_URI` | MongoDB connection string (e.g. MongoDB Atlas) |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 5000 | Web server port |
| `HOST` | 0.0.0.0 | Bind address |
| `BASE_URL` | (none) | Public URL for CORS (optional) |

## Project structure

```
index.js                  # Entry point — Discord client + bootstrap
src/
  models/
    ticketPanel.js        # MongoDB schema for ticket panel config
    staffStats.js         # MongoDB schema for staff claim counts
  services/
    ticketService.js      # Business logic for tickets
  web/
    server.js             # Express API + static file server
    public/
      index.html          # Web dashboard (Arabic RTL UI)
```

## User preferences

- Keep existing project structure and stack.
