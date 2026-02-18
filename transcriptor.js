#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(__dirname, 'config.json')
const STATE_PATH = join(__dirname, '.state.json')

// ---------------------------------------------------------------------------
// Config & state
// ---------------------------------------------------------------------------

if (!existsSync(CONFIG_PATH)) {
  console.error('Missing config.json — copy config.example.json and fill in your values.')
  process.exit(1)
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
const { fathomApiKey, claudeApiKey, outputDir } = config

if (!fathomApiKey || !claudeApiKey || !outputDir) {
  console.error('config.json must include fathomApiKey, claudeApiKey, and outputDir.')
  process.exit(1)
}

let state = { downloadedIds: [] }
if (existsSync(STATE_PATH)) {
  state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
}

function saveState() {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
}

// ---------------------------------------------------------------------------
// Fathom API
// ---------------------------------------------------------------------------

async function fathomGet(path, params = {}) {
  const url = new URL(`https://api.fathom.ai/external/v1${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, { headers: { 'X-Api-Key': fathomApiKey } })
  if (!res.ok) throw new Error(`Fathom API error ${res.status}: ${await res.text()}`)
  return res.json()
}

async function fetchAllMeetings() {
  const meetings = []
  let cursor = null
  do {
    const params = cursor ? { cursor } : {}
    const data = await fathomGet('/meetings', params)
    meetings.push(...(data.items || []))
    cursor = data.next_cursor
  } while (cursor)
  return meetings
}

async function fetchTranscript(recordingId) {
  const data = await fathomGet(`/recordings/${recordingId}/transcript`)
  return data.transcript || []
}

// ---------------------------------------------------------------------------
// Claude API
// ---------------------------------------------------------------------------

async function cleanTranscript(transcript, title) {
  const rawText = transcript
    .map(item => `${item.speaker.display_name}: ${item.text}`)
    .join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: `Clean up this meeting transcript to make it human-readable. Remove all timestamps. Group consecutive lines from the same speaker into a single paragraph. Add a blank line between different speakers. Preserve every word of the actual content — do not summarize, paraphrase, or omit anything. Output only the cleaned transcript with no preamble or commentary.

Meeting: ${title}

${rawText}`,
        },
      ],
    }),
  })

  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.content[0].text
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDatePrefix(dateStr) {
  const d = new Date(dateStr)
  const yy = String(d.getFullYear()).slice(2)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${yy}${mm}${dd}-${hh}${min}${ss}`
}

function sanitizeTitle(title) {
  return (title || 'untitled')
    .toLowerCase()
    .trim()
    .replace(/[/\\:*?"<>|]/g, '') // strip characters invalid in filenames
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Fetching meetings from Fathom...')
  const meetings = await fetchAllMeetings()
  console.log(`  ${meetings.length} total meeting(s) found.`)

  const newMeetings = meetings.filter(m => !state.downloadedIds.includes(m.recording_id))

  if (newMeetings.length === 0) {
    console.log('No new transcripts to download.')
    return
  }

  console.log(`  ${newMeetings.length} new meeting(s) to process.\n`)
  mkdirSync(outputDir, { recursive: true })

  for (const meeting of newMeetings) {
    const { recording_id, title, meeting_title, recording_start_time, created_at } = meeting
    const meetingTitle = meeting_title || title || 'untitled'
    const dateStr = recording_start_time || created_at

    console.log(`Processing: ${meetingTitle}`)

    try {
      const transcript = await fetchTranscript(recording_id)

      if (transcript.length === 0) {
        console.log('  No transcript available, skipping.\n')
        continue
      }

      console.log(`  Cleaning with Claude...`)
      const cleaned = await cleanTranscript(transcript, meetingTitle)

      const prefix = formatDatePrefix(dateStr)
      const fileName = `${prefix} ${sanitizeTitle(meetingTitle)}.txt`
      const filePath = join(outputDir, fileName)

      writeFileSync(filePath, cleaned, 'utf-8')
      console.log(`  Saved: ${fileName}\n`)

      state.downloadedIds.push(recording_id)
      saveState()
    } catch (err) {
      console.error(`  Error: ${err.message}\n`)
    }
  }

  console.log('Done.')
}

main().catch(err => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
