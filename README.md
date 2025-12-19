# Bluesky Autoposter

Automated Bluesky posting powered by [Nova AI](https://inferenco.com/app.html#docs). Nova generates engaging posts using its built-in knowledge base.

## How It Works

1. **Random Image** - Selects an image from `assets/images/originals/`
2. **Nova AI** - Generates post text + hashtags using its knowledge base  
3. **Publish** - Posts to Bluesky with the image

## Setup

### 1. Get a Nova API Key

1. Open the [Nova Telegram bot](https://t.me/NovaInferencoBot)
2. Send `/usersettings` → Click "🔑 API Key" → Create new key
3. Fund your account with APT, USDC, USDT, or GUI

### 2. Create Bluesky App Password

1. Go to [Bluesky Settings](https://bsky.app/settings/app-passwords)
2. Create a new app password

### 3. Add Images

Place your images in `assets/images/originals/`. Supported formats: `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif` (under 1MB each).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NOVA_API_KEY` | ✅ | Nova API key |
| `BSKY_HANDLE` | ✅ | Your Bluesky handle (e.g., `user.bsky.social`) |
| `BSKY_APP_PASSWORD` | ✅ | Bluesky app password |
| `TG_BOT_TOKEN` | ❌ | Telegram bot token for notifications |
| `TG_CHAT_ID` | ❌ | Telegram chat ID for notifications |
| `DRY_RUN` | ❌ | Set to `true` to test without posting |

## Running Locally

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env` file

```bash
NOVA_API_KEY=nova_your_key_here
BSKY_HANDLE=yourhandle.bsky.social
BSKY_APP_PASSWORD=your-app-password

# Optional: Telegram notifications
TG_BOT_TOKEN=your_bot_token
TG_CHAT_ID=your_chat_id
```

### 3. Load env and run

```bash
# Using dotenv
npx dotenv -e .env -- npm run autopost

# Or export manually
export $(cat .env | xargs) && npm run autopost

# Dry run (no actual posting)
export $(cat .env | xargs) && DRY_RUN=true npm run autopost
```

## GitHub Actions

The bot runs automatically via GitHub Actions. Add these secrets to your repository:

- `NOVA_API_KEY`
- `BSKY_HANDLE`
- `BSKY_APP_PASSWORD`
- `TG_BOT_TOKEN` (optional)
- `TG_CHAT_ID` (optional)

## Configuration

Edit `config/schedule.json`:

```json
{
  "posts_per_day": 3,
  "quiet_hours_utc": ["02:00", "08:00"],
  "random_jitter_minutes": 15
}
```

## Development

```bash
npm run lint      # TypeScript check
npm run test      # Run tests
npm run autopost  # Run the bot
```
