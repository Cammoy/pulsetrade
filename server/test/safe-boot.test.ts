// SAFE BOOT: an unattended restart must NEVER auto-resume real on-chain trading.
// disarmLiveBotsForBoot() pauses every running LIVE on-chain bot (bot.mode is independent
// of the viewed workspace, so the global flag-downgrade alone doesn't stop them) and
// stops a live auto-sniper. Paper bots + paper-only-network bots are untouched.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsetrade-boot-'))

const { state } = await import('../src/store.js')
const { disarmLiveBotsForBoot } = await import('../src/engine.js')

beforeEach(() => {
  state.bots = []
  state.autoSniper = null
})

test('pauses running/scheduled LIVE on-chain bots; leaves paper + paper-only-network + stopped bots', () => {
  state.bots = [
    { id: '1', mode: 'live', status: 'running', network: 'arbitrum' },
    { id: '2', mode: 'live', status: 'scheduled', network: 'base' },
    { id: '3', mode: 'paper', status: 'running', network: 'arbitrum' }, // PAPER — untouched
    { id: '4', mode: 'live', status: 'running', network: 'market' }, // no live executor — untouched
    { id: '5', mode: 'live', status: 'running', network: 'icp' }, // no live executor — untouched
    { id: '6', mode: 'live', status: 'stopped', network: 'arbitrum' }, // already stopped — untouched
  ] as unknown as typeof state.bots

  const paused = disarmLiveBotsForBoot()
  assert.equal(paused, 2, 'only the two running LIVE on-chain bots were paused')
  assert.equal(state.bots[0].status, 'paused')
  assert.equal(state.bots[1].status, 'paused')
  assert.equal(state.bots[2].status, 'running', 'paper bot keeps running')
  assert.equal(state.bots[3].status, 'running', 'market (paper-only) keeps running')
  assert.equal(state.bots[4].status, 'running', 'icp (paper-only) keeps running')
  assert.equal(state.bots[5].status, 'stopped', 'already-stopped bot untouched')
})

test('stops a LIVE auto-sniper on boot, but leaves a PAPER one running', () => {
  state.autoSniper = { enabled: true, workspace: 'live' } as unknown as typeof state.autoSniper
  disarmLiveBotsForBoot()
  assert.equal(state.autoSniper!.enabled, false, 'live auto-sniper stopped — no auto-resume of live snipes')

  state.autoSniper = { enabled: true, workspace: 'paper' } as unknown as typeof state.autoSniper
  disarmLiveBotsForBoot()
  assert.equal(state.autoSniper!.enabled, true, 'paper auto-sniper keeps scanning')
})
