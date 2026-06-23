// Bot archiving: archiveBot hides a bot from the active list. Archiving a running bot
// also pauses it (an archived bot must never quietly trade); un-archiving clears the
// flag without resuming; resuming a bot clears the archive flag too.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-archive-'))

const { state } = await import('../src/store.js')
const { createBot, archiveBot, controlBot } = await import('../src/engine.js')

beforeEach(() => {
  state.bots.length = 0
})

function freshBot() {
  const b = createBot({ network: 'base', token: 'LINK', strategy: 'grid', risk: 'balanced', budgetUsd: 100 })
  assert.ok(!('error' in b), 'bot created')
  return b as Exclude<typeof b, { error: string }>
}

test('archiving a running bot pauses it and sets the flag', () => {
  const id = freshBot().id
  const out = archiveBot(id, true)
  assert.ok(!('error' in out))
  const b = out as Exclude<typeof out, { error: string }>
  assert.equal(b.archived, true)
  assert.equal(b.status, 'paused') // never leave an archived bot running
})

test('un-archiving clears the flag without resuming', () => {
  const id = freshBot().id
  archiveBot(id, true)
  const out = archiveBot(id, false)
  const b = out as Exclude<typeof out, { error: string }>
  assert.equal(b.archived, false)
  assert.equal(b.status, 'paused') // stays paused — user resumes deliberately
})

test('resuming an archived bot clears the archive flag too', async () => {
  const id = freshBot().id
  archiveBot(id, true)
  const out = await controlBot(id, 'resume')
  const b = out as Exclude<typeof out, { error: string }>
  assert.equal(b.archived, false)
  assert.equal(b.status, 'running')
})

test('archiving an unknown bot id errors', () => {
  assert.ok('error' in archiveBot('does-not-exist', true))
})
