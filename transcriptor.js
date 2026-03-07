#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(__dirname, 'config.json')
const STATE_PATH = join(__dirname, 'state.json')

// ---------------------------------------------------------------------------
// Config & state
// ---------------------------------------------------------------------------

if (!existsSync(CONFIG_PATH)) {
  console.error('Missing config.json — copy config.example.json and fill in your values.')
  process.exit(1)
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
const { fathomApiKey, outputDir, recordedBy, teams, meetingNames, lookbackWeeks = 3 } = config

if (!fathomApiKey || !outputDir) {
  console.error('config.json must include fathomApiKey and outputDir.')
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

async function fathomFetch(url, retries = 5) {
  const endpoint = url.pathname.replace('/external/v1', '') + (url.search || '')
  for (let attempt = 0; attempt <= retries; attempt++) {
    console.log(`  API ${attempt > 0 ? `(retry ${attempt}) ` : ''}GET ${endpoint}`)
    const res = await fetch(url, { headers: { 'X-Api-Key': fathomApiKey } })
    if (res.status === 429 && attempt < retries) {
      const retryAfter = res.headers.get('retry-after')
      const delay = retryAfter ? Number(retryAfter) * 1000 : 2000 * 2 ** attempt
      console.log(`  Rate limited (429), retrying in ${Math.round(delay / 1000)}s...`)
      await new Promise(r => setTimeout(r, delay))
      continue
    }
    if (!res.ok) throw new Error(`Fathom API error ${res.status}: ${await res.text()}`)
    console.log(`  OK (${res.status})`)
    return res.json()
  }
}

function fathomUrl(path, params = {}) {
  const url = new URL(`https://api.fathom.ai/external/v1${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url
}

async function fetchAllMeetings() {
  const meetings = []
  let cursor = null
  let page = 1
  const createdAfter = new Date(Date.now() - lookbackWeeks * 7 * 24 * 60 * 60 * 1000).toISOString()
  const filters = [`since: ${createdAfter.slice(0, 10)}`]
  if (teams) {
    const t = Array.isArray(teams) ? teams : [teams]
    filters.push(`teams: ${t.join(', ')}`)
  }
  if (recordedBy) {
    const emails = Array.isArray(recordedBy) ? recordedBy : [recordedBy]
    filters.push(`recorded by: ${emails.join(', ')}`)
  }
  if (meetingNames) {
    const names = Array.isArray(meetingNames) ? meetingNames : [meetingNames]
    filters.push(`meeting names: ${names.join(', ')}`)
  }
  console.log(`  Filters: ${filters.join(' | ')}`)
  do {
    const url = fathomUrl('/meetings')
    url.searchParams.set('created_after', createdAfter)
    if (cursor) url.searchParams.set('cursor', cursor)
    if (teams) {
      const t = Array.isArray(teams) ? teams : [teams]
      for (const team of t) url.searchParams.append('teams[]', team)
    }
    if (recordedBy) {
      const emails = Array.isArray(recordedBy) ? recordedBy : [recordedBy]
      for (const email of emails) url.searchParams.append('recorded_by[]', email)
    }
    console.log(`  Fetching meetings page ${page}...`)
    const data = await fathomFetch(url)
    const items = data.items || []
    meetings.push(...items)
    console.log(`  Got ${items.length} meeting(s) (${meetings.length} total so far)`)
    cursor = data.next_cursor
    page++
  } while (cursor)
  return meetings
}

async function fetchTranscript(recordingId) {
  const data = await fathomFetch(fathomUrl(`/recordings/${recordingId}/transcript`))
  return data.transcript || []
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
  console.log(`Found ${meetings.length} meeting(s) from API.`)

  let filtered = meetings
  if (meetingNames) {
    const names = (Array.isArray(meetingNames) ? meetingNames : [meetingNames])
      .map(n => n.toLowerCase())
    filtered = meetings.filter(m => {
      const title = (m.meeting_title || m.title || '').toLowerCase()
      return names.some(n => title.includes(n))
    })
    console.log(`  ${filtered.length} match meeting name filter, ${meetings.length - filtered.length} skipped.`)
  }

  console.log(`${state.downloadedIds.length} previously downloaded.`)

  const newMeetings = filtered.filter(m => !state.downloadedIds.includes(m.recording_id))

  if (newMeetings.length === 0) {
    console.log('No new transcripts to download.')
    return
  }

  console.log(`  ${newMeetings.length} new meeting(s) to process.\n`)

  for (const meeting of newMeetings) {
    const { recording_id, title, meeting_title, recording_start_time, created_at } = meeting
    const meetingTitle = meeting_title || title || 'untitled'
    const dateStr = recording_start_time || created_at

    const idx = newMeetings.indexOf(meeting) + 1
    console.log(`[${idx}/${newMeetings.length}] ${meetingTitle} (${dateStr || 'no date'})`)

    try {
      console.log(`  Fetching transcript for recording ${recording_id}...`)
      const transcript = await fetchTranscript(recording_id)

      if (transcript.length === 0) {
        console.log('  No transcript available, skipping.\n')
        continue
      }

      console.log(`  Got ${transcript.length} transcript line(s)`)

      const cleaned = transcript
        .map(item => `[${item.timestamp}] ${item.speaker.display_name}: ${item.text}`)
        .join('\n')

      const subfolder = meetingTitle.toLowerCase().includes('ui standup')
        ? 'UI Standup'
        : 'Product & Engineering'
      const subDir = join(outputDir, subfolder)
      mkdirSync(subDir, { recursive: true })

      const prefix = formatDatePrefix(dateStr)
      const fileName = `${prefix} ${sanitizeTitle(meetingTitle)}.txt`
      const filePath = join(subDir, fileName)

      writeFileSync(filePath, cleaned, 'utf-8')
      console.log(`  Saved: ${subfolder}/${fileName}\n`)

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
