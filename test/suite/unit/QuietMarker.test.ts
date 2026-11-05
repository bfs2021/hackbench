/**
 * The quiet marker (#1011): a verdict, never an id list. All synthetic, so CI (no ROM) runs it; the vanilla
 * corpus cases are in QuietMarker.corpus.test.ts.
 */
import { describe, it, expect } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { loadClasses } from '../../../src/rom/sprites/interp/LoadClass'
import { drawSprites, type SpriteDrawResult } from '../../../theia/extension/src/node/map-sprites'
import {
  spriteAt,
  spriteDoors,
  spriteName,
} from '../../../theia/extension/src/browser/map-view-model'
import { quietText, spriteProps } from '../../../theia/extension/src/browser/sprite-props'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'
import { COLORS } from '../support/mapInputs'

const sprite = (spriteId: number, index = 0, raw0 = 0): LevelSprite =>
  ({ screen: 0, x: 3, y: 4, spriteId, extraBit: false, raw: [raw0, 0, 0], index }) as LevelSprite
const model = { vram: {} as never, colors: COLORS }
const draw = (results: Record<number, SpriteDrawResult>) => (s: LevelSprite) => results[s.spriteId]!
const run = (sprites: LevelSprite[], results: Record<number, SpriteDrawResult>) =>
  drawSprites(sprites, model, draw(results))
const alpha = (d: MapSpriteDto) => {
  const b = Buffer.from(d.rgba, 'base64')
  return (x: number, y: number) => b[(y * 16 + x) * 4 + 3]!
}

describe('the verdict decides the marker', () => {
  const failed: SpriteDrawResult = { ok: false, reason: 'refused: INIT: step budget spent' }
  const empty: SpriteDrawResult = { ok: false, reason: 'drew no OAM tile', empty: true }
  const routed: SpriteDrawResult = { ok: false, reason: 'routed', routed: 'scroll' }

  it('an empty run is quiet; a refusal, a missing descriptor and no parts keep the failure box', () => {
    const [a, b, c, d] = run([sprite(1, 0), sprite(2, 1), sprite(3, 2), sprite(4, 3)], {
      1: empty,
      2: failed,
      3: { ok: false, failure: { kind: 'noDescriptor', spriteId: 3 } },
      4: {
        ok: true,
        parts: [],
        identity: { spriteId: 4, mainHandler: 0, initHandler: 0, status: 'vanilla' },
      },
    })
    expect([a!.status, b!.status, c!.status, d!.status]).toEqual(['quiet', 'placeholder', 'placeholder', 'placeholder']) // prettier-ignore
    expect(b!.reason).toBe('refused: INIT: step budget spent')
    expect(a!.kind).toBeUndefined()
  })

  it('does not decide by id: the same id is quiet or a failure box by what the run said', () => {
    const [q] = run([sprite(0xc9)], { 0xc9: empty })
    const [f] = run([sprite(0xc9)], { 0xc9: failed })
    expect([q!.status, f!.status]).toEqual(['quiet', 'placeholder'])
  })

  it('a routed scroll command is quiet even with the extra bits set; a routed shooter with them is not', () => {
    const [scroll] = run([sprite(0xe8, 0, 0x08)], { 0xe8: routed })
    expect(scroll).toMatchObject({ status: 'quiet', kind: 'scroll' })
    const [shooter] = run([sprite(0xc9, 0, 0x08)], { 0xc9: { ...routed, routed: 'shooter' } })
    expect(shooter).toMatchObject({ status: 'placeholder', reason: 'extraBits' })
    expect(run([sprite(0x10, 0, 0x08)], { 0x10: empty })[0]!.reason).toBe('extraBits')
  })
})

describe('the marker', () => {
  const [d] = run([sprite(0xc9)], { 0xc9: { ok: false, reason: 'x', routed: 'shooter' } })
  const a = alpha(d!)

  it('is 16 x 16 at the placed spot, with a clear interior and clear corners', () => {
    expect(d!.box).toEqual({ x0: 48, y0: 64, x1: 64, y1: 80 })
    for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15], [5, 7], [7, 5], [10, 8], [8, 10]]) expect(a(x!, y!)).toBe(0) // prettier-ignore
  })

  it('draws a ring and a center dot, with a dark edge so it reads on light and dark art', () => {
    const px = (x: number, y: number) => Array.from(Buffer.from(d!.rgba, 'base64').subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 3)) // prettier-ignore
    expect(a(7, 7)).toBe(255)
    expect(a(1, 7) + a(14, 7) + a(7, 1) + a(7, 14)).toBeGreaterThan(0)
    const lum = (c: number[]) => c[0]! + c[1]! + c[2]!
    const colors = new Set<number>()
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (a(x, y)) colors.add(lum(px(x, y)))
    expect(Math.max(...colors)).toBeGreaterThan(600)
    expect(Math.min(...colors)).toBeLessThan(150)
    let lit = 0
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (a(x, y)) lit++
    expect(lit).toBeLessThan(120)
  })

  it('is hit anywhere in its box, the clear interior included, and the screen door skips it', () => {
    const g = { orientation: 'horizontal' as const, screenCount: 1, width: 512, height: 432 }
    const sprites = [d!]
    expect(spriteAt(sprites, g, 55, 71)?.index).toBe(d!.index) // the clear interior
    expect(spriteAt(sprites, g, 47, 71)).toBeUndefined()
    const doors = spriteDoors({ ...g, sprites }, 0)
    expect(doors && doors.every(v => v === 0)).toBe(true)
  })
})

describe('plain words', () => {
  it('names the class, then why nothing shows, with no jargon', () => {
    const words = [
      quietText({ kind: 'shooter', name: 'Bullet Bill Shooter' }),
      quietText({ kind: 'scroll', name: 'Whatever' }),
      quietText({ kind: undefined, name: 'Some Sprite' }),
      quietText({ kind: undefined, name: undefined }),
    ]
    expect(words[0]).toBe('Bullet Bill Shooter: fires on a timer; nothing is drawn until it does')
    expect(words[1]).toBe('Scroll command: changes how the screen scrolls; it has no picture in the game') // prettier-ignore
    expect(words[2]).toBe('Some Sprite: runs normally, but draws nothing on the map')
    expect(words[3]).toBe('Runs normally, but draws nothing on the map')
    for (const w of words) expect(w).not.toMatch(/OAM|pass|\$|0x|github|water|fog/i)
  })

  it('the hover and Properties carry it; a failed sprite keeps the old line', () => {
    const [q, f] = run([sprite(0xe8, 0), sprite(2, 1)], { 0xe8: { ok: false, reason: 'r', routed: 'scroll' }, 2: { ok: false, reason: 'refused: x' } }) // prettier-ignore
    expect(spriteName(q!)).toMatch(/^Scroll command/)
    expect(spriteProps(q!).notes[0]).toMatch(/^Scroll command: .*game\.$/)
    expect(spriteProps(f!).notes[0]).toMatch(/^Not drawn: /)
  })
})

// A bank-2 window carrying only the loader's opcode shapes, with operands unlike the game's.
function cart(over: { scrollSub?: number; skipShooter?: boolean } = {}): RomFile {
  const buf = Buffer.alloc(0x80000)
  buf[0x7fd5] = 0x20
  const put = (at: number, bytes: number[]) => buf.set(bytes, 0x10000 + at)
  put(0x100, [0xc9, 0xa0, 0x90, 0x40, 0xad, 0x34, 0x12, 0x0d, 0x56, 0x12, 0xd0, 0x20, 0x5a, 0xda, 0xa5, 0x05, 0x38, 0xe9, over.scrollSub ?? 0xa0, 0x8d, 0x78, 0x12]) // prettier-ignore
  // generator test: ids 0x50..0x5f; its low branch (+0x10) lands on the shooter test at 0x214
  put(0x200, [0xc9, 0x50, 0x90, 0x10, 0xc9, 0x60, 0xb0, 0x20, 0x38, 0xe9, 0x50, 0x1a, 0x8d, 0x9a, 0x12]) // prettier-ignore
  if (!over.skipShooter) put(0x214, [0xc9, 0x4e, 0x90, 0x08, 0x20, 0x00, 0x90, 0x80, 0x02, 0xa9, 0x01]) // prettier-ignore
  return RomFile.fromBytes('x.sfc', buf)
}

describe('LoadClass reads the loader from its operands', () => {
  it('classes follow the planted bounds, not the game values', () => {
    const r = loadClasses(cart())
    if (r.status !== 'ok') throw new Error(r.reason)
    expect([0x10, 0x4d, 0x4e, 0x4f, 0x50, 0x5f, 0x60, 0x9f, 0xa0, 0xff].map(r.of)).toEqual(['normal', 'normal', 'shooter', 'shooter', 'generator', 'generator', 'normal', 'normal', 'scroll', 'scroll']) // prettier-ignore
  })

  it('refuses, with a reason, when a test is missing or two bounds disagree', () => {
    expect(loadClasses(cart({ skipShooter: true }))).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('shooter') }) // prettier-ignore
    expect(loadClasses(cart({ scrollSub: 0xa1 }))).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('scroll') }) // prettier-ignore
    expect(loadClasses(RomFile.fromBytes('x.sfc', Buffer.alloc(0x80000)))).toMatchObject({ status: 'unavailable' }) // prettier-ignore
  })
})
