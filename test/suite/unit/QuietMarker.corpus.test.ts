/**
 * The quiet marker on the vanilla ROM (#1011): what the game's own loader routes away from the sprite slots shows the
 * quiet marker, never the failure box. ROM-gated; the synthetic cases are in QuietMarker.test.ts.
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import { parseLevelSprites } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { mapSprites } from '../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { quietText } from '../../../theia/extension/src/browser/sprite-props'
import { VANILLA, hasRom, romPath } from '../support/corpus'
import { slow } from '../support/loadTimeout'

describe.skipIf(!hasRom(VANILLA))('quiet marker on the vanilla ROM', () => {
  const bytes = new Uint8Array(hasRom(VANILLA) ? readFileSync(romPath(VANILLA)) : 0)
  const get = (map: number) => {
    const r = mapSprites(new L1ModelCache(), bytes, romPath(VANILLA), map)
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    return r.sprites
  }

  it(
    '$C9 on $126 is the quiet marker with the shooter words, not the framed id box',
    slow(60_000),
    () => {
      const c9 = get(0x126).filter(s => s.id === 0xc9)
      expect(c9.length).toBe(16)
      for (const s of c9) {
        expect(s).toMatchObject({ status: 'quiet', kind: 'shooter', name: 'Bullet Bill Shooter' })
        expect(quietText(s)).toBe(
          'Bullet Bill Shooter: fires on a timer; nothing is drawn until it does',
        )
        expect(quietText(s)).not.toMatch(/OAM|pass/i)
      }
    },
  )

  it(
    'every quiet marker on $10A and $126 draws at priority 3, above any tile (no ids named: #1132 draws some)',
    slow(60_000),
    () => {
      const quiet = [...get(0x10a), ...get(0x126)].filter(s => s.status === 'quiet')
      expect(quiet.length).toBeGreaterThan(0)
      for (const s of quiet)
        expect(Array.from(Buffer.from(s.priority!, 'base64')).every(p => p === 3)).toBe(true)
    },
  )
  it(
    'every scroll command $E7-$FF placed on a vanilla map is the quiet marker, named as a scroll command',
    slow(120_000),
    () => {
      // The maps are found from the sprite streams alone (cheap), then each is served for real.
      const rom = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(bytes)))
      const maps: number[] = []
      for (let m = 0; m < 0x200; m++) {
        const ptr = rom.getLevelSpritePointer(m)
        const data = ptr === null ? null : rom.rom.readUpTo(ptr, 0x200)
        if (data && parseLevelSprites(data, false).some(s => s.spriteId >= 0xe7)) maps.push(m)
      }
      expect(maps.length).toBeGreaterThan(3)
      const scroll = maps.flatMap(m => get(m).filter(s => s.id >= 0xe7))
      expect(scroll.length).toBeGreaterThan(5)
      expect(scroll.filter(s => s.status !== 'quiet' || s.kind !== 'scroll')).toEqual([])
      expect(new Set(scroll.map(quietText))).toEqual(
        new Set(['Scroll command: changes how the screen scrolls; it has no picture in the game']),
      )
    },
  )
})
