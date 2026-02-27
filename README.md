# Transcriptor

A minimal Node.js CLI tool that downloads new transcripts from [Fathom](https://fathom.video/) and saves them as plaintext files.

No npm install required — uses only Node.js built-in APIs (requires Node 18+).

## Setup

1. Copy the example config and fill in your values:

```bash
cp config.example.json config.json
```

2. Edit `config.json`:

```json
{
  "fathomApiKey": "YOUR_FATHOM_API_KEY",
  "outputDir": "/Users/you/Documents/Transcripts"
}
```

- **fathomApiKey** — found in Fathom under User Settings → API Access
- **outputDir** — absolute path to the folder where transcript files will be saved

## Usage

```bash
node transcriptor.js
```

On each run, the tool checks which meetings have already been downloaded (tracked in `.state.json`) and only processes new ones.

## Output

Transcripts are saved as `.txt` files named by date, time, and meeting title:

```
260218-142559 team standup.txt
```

Each line includes the timestamp, speaker name, and what they said.

## Automation

To run weekly automatically, add a cron job:

```bash
crontab -e
```

```
0 9 * * 1 /usr/local/bin/node /path/to/transcriptor/transcriptor.js >> /path/to/transcriptor/transcriptor.log 2>&1
```

This runs every Monday at 9am. Adjust the path to `node` as needed (`which node` to find it).
