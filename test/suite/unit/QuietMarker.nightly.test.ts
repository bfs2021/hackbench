/**
 * The vanilla sweep for #1011: which placed items moved from the framed id box to the quiet marker, by id, over all 512
 * maps of the vanilla ROM (about 90 s, one machine, 2026-11-05). Pinned, so a change in what is quiet shows. $C7 is left
 * out of the pin: it moves under the reveal work (#1132). Set QUIET_SWEEP_OUT to also write the table to a file.
 */
import { readFileSync, writeFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import { mapSprites } from '../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { VANILLA, hasRom, romPath } from '../support/corpus'

describe.skipIf(!hasRom(VANILLA))('quiet marker sweep, vanilla', () => {
  it('lists the quiet items by id and kind', { timeout: 600_000 }, () => {
    const bytes = new Uint8Array(readFileSync(romPath(VANILLA)))
    const cache = new L1ModelCache()
    const by = new Map<string, number>()
    for (let map = 0; map < 0x200; map++) {
      const r = mapSprites(cache, bytes, romPath(VANILLA), map)
      if (r.status !== 'ok') continue
      for (const s of r.sprites.filter(s => s.status === 'quiet')) {
        const k = `${s.id.toString(16)} ${s.kind ?? 'other'}`
        by.set(k, (by.get(k) ?? 0) + 1)
      }
    }
    const table = [...by].sort().map(([k, n]) => `${k} x${n}`)
    if (process.env.QUIET_SWEEP_OUT) writeFileSync(process.env.QUIET_SWEEP_OUT, table.join('\n'))
    expect(table.filter(l => !l.startsWith('c7 '))).toEqual(PINNED)
  })
})

const PINNED = [
  '19 other x1', '1f other x1', '4d other x2', '4e other x4', '54 other x6', '6d other x4',
  '89 other x3', '8c other x1', '8e other x6', 'a8 other x2',
  'c9 shooter x20',
  'cc generator x1', 'cd generator x3', 'cf generator x2', 'd0 generator x1', 'd1 generator x1',
  'd2 generator x5', 'd3 generator x2', 'd4 generator x4', 'd5 generator x1', 'd6 generator x2',
  'd7 generator x1', 'd8 generator x1', 'd9 generator x17',
  'e8 scroll x3', 'e9 scroll x4', 'ea scroll x6', 'ef scroll x2', 'f2 scroll x1', 'f3 scroll x4',
  'f4 scroll x1', 'f5 scroll x3',
] // prettier-ignore
