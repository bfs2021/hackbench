/**
 * The quiet marker (#1011): a verdict, never an id list. All synthetic, so CI (no ROM) runs it; the vanilla
 * corpus cases are in QuietMarker.corpus.test.ts.
 */
import { describe, it, expect } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { composeScreen } from '../../../src/rom/model/ColorMath'
import { FALLBACK_SCREENS } from '../../../src/rom/model/ScreenPlanes'
import { loadClasses, SHAPES, type LoadClass } from '../../../src/rom/sprites/interp/LoadClass'
import { withSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import type { SpriteModel } from '../../../src/rom/sprites/interp/SpriteRunner'
import {
  drawSprites,
  framesGate,
  framesOf,
  interpDrawer,
  modelResult,
  spriteLayer,
  type SpriteDrawResult,
} from '../../../theia/extension/src/node/map-sprites'
import {
  spriteAt,
  spriteDoors,
  spriteName,
  spritePlanes,
} from '../../../theia/extension/src/browser/map-view-model'
import {
  framesReasonText,
  noteTitle,
  quietText,
  spriteProps,
  UNVERIFIED_NOTE,
  WHY_NOT_DRAWN,
} from '../../../theia/extension/src/browser/sprite-props'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'
import { COLORS } from '../support/mapInputs'

/** A list sprite with the given id, index and first raw byte (bit 3 is the extra-bits flag). */
const sprite = (spriteId: number, index = 0, raw0 = 0): LevelSprite =>
  ({ screen: 0, x: 3, y: 4, spriteId, extraBit: false, raw: [raw0, 0, 0], index }) as LevelSprite
/** The minimal sprite model drawSprites needs when no pixel is blitted (a verdict-only stand-in). */
const model = { vram: {} as never, colors: COLORS }
// A test stand-in for the loader's routing; production reads it from the ROM (LoadClass.ts).
const routedOf = (id: number): LoadClass =>
  id >= 0xe7 ? 'scroll' : id === 0xc9 ? 'shooter' : 'normal'
/** A drawer that answers each sprite id from a fixed table of results. */
const draw = (results: Record<number, SpriteDrawResult>) => (s: LevelSprite) => results[s.spriteId]!
/** Draws the sprites through drawSprites with the fixed results and the test routing. */
const run = (sprites: LevelSprite[], results: Record<number, SpriteDrawResult>) =>
  drawSprites(sprites, model, draw(results), undefined, routedOf)
/** Reads a DTO bitmap's alpha at a local pixel. */
const alpha = (d: MapSpriteDto) => {
  const b = Buffer.from(d.rgba, 'base64')
  return (x: number, y: number) => b[(y * 16 + x) * 4 + 3]!
}
/** A run model with no passes, overridden by `o`, as the interpreter would hand back. */
const runModel = (o: Partial<SpriteModel>): SpriteModel => ({ id: 1, passes: [], dependsOn: [], steps: [], ...o }) // prettier-ignore

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

  it('an empty run on a generic (unverified) seed keeps the box and its warning', () => {
    const generic = modelResult(runModel({ seedSource: 'generic', seedReason: 'no stock loader', emptyReason: 'drew no OAM tile' })) // prettier-ignore
    expect(generic).toMatchObject({ ok: false, empty: true, unverified: expect.stringContaining('no stock loader') }) // prettier-ignore
    const [d] = run([sprite(1)], { 1: generic })
    expect(d).toMatchObject({ status: 'placeholder', unverified: expect.stringContaining('no stock loader') }) // prettier-ignore
    const [verified] = run([sprite(1)], { 1: modelResult(runModel({ emptyReason: 'drew no OAM tile' })) }) // prettier-ignore
    expect(verified!.status).toBe('quiet')
  })

  it('a run with no chosen pass is empty only when the run says so (develop line and anchor line)', () => {
    expect(modelResult(runModel({ emptyReason: 'drew no OAM tile' }))).toMatchObject({
      ok: false,
      empty: true,
    })
    const unsaid = modelResult(runModel({}))
    expect(unsaid).toEqual({ ok: false, reason: 'drew no tile' })
    expect(run([sprite(1)], { 1: unsaid })[0]!.status).toBe('placeholder')
    const pass = { pass: 0, pos: { x: 0, y: 0 }, origin: { x: 0, y: 0 }, parts: [], uploads: [], palette: [] } // prettier-ignore
    expect(modelResult(runModel({ passes: [pass], chosen: 0, emptyReason: 'x' }))).toMatchObject({ ok: false, empty: true }) // prettier-ignore
    expect(modelResult(runModel({ passes: [pass], chosen: 0 }))).toEqual({
      ok: false,
      reason: 'drew no tile',
    })
  })

  it('spriteLayer passes the loader routing on: a scroll command with extra bits is quiet only with it', () => {
    const stream = Uint8Array.from([0, 0x08, 0x01, 0xe8, 0xff]) // one entry, id $E8, extra bit 3 set
    const m = { ...model, isVertical: false, screenCount: 1 }
    const d = draw({ 0xe8: { ok: false, reason: 'r', routed: 'scroll' } })
    expect(spriteLayer(stream, m, d).sprites[0]).toMatchObject({
      status: 'placeholder',
      reason: 'extraBits',
    })
    expect(spriteLayer(stream, m, d, undefined, routedOf).sprites[0]).toMatchObject({ status: 'quiet', kind: 'scroll' }) // prettier-ignore
  })

  it('a scroll command with extra bits is told "no picture", not the custom-sprite line, in the animation text', () => {
    const s = sprite(0xe8, 0, 0x08)
    expect(framesGate(s, routedOf)).toBe('it has no picture')
    expect(framesGate(sprite(0x10, 0, 0x08), routedOf)).toBe('extraBits')
    expect(framesGate(sprite(0xc9, 0, 0x08), routedOf)).toBe('extraBits') // a boxed shooter keeps the box's words
    expect(framesGate(sprite(0x10), routedOf)).toBeUndefined()
    expect(framesReasonText(framesGate(s, routedOf)!)).not.toMatch(/extra-bits/)
  })
  it('a routed scroll command is quiet even with the extra bits set; a routed shooter with them is not', () => {
    const [scroll] = run([sprite(0xe8, 0, 0x08)], { 0xe8: routed })
    expect(scroll).toMatchObject({ status: 'quiet', kind: 'scroll' })
    const [shooter] = run([sprite(0xc9, 0, 0x08)], { 0xc9: { ...routed, routed: 'shooter' } })
    expect(shooter).toMatchObject({ status: 'placeholder', reason: 'extraBits' })
    expect(run([sprite(0x10, 0, 0x08)], { 0x10: empty })[0]!.reason).toBe('extraBits')
  })

  it('the extra-bits gate is before the draw: an extra-bits sprite that is not a scroll command never runs its code', () => {
    const ran: number[] = []
    const spy = (s: LevelSprite): SpriteDrawResult => {
      ran.push(s.spriteId)
      throw new Error('custom code must not run')
    }
    const out = drawSprites([sprite(0x10, 0, 0x08), sprite(0xc9, 1, 0x08)], model, spy, undefined, routedOf) // prettier-ignore
    expect(out.map(d => d.reason)).toEqual(['extraBits', 'extraBits'])
    expect(ran).toEqual([])
    expect(() => drawSprites([sprite(0xe8, 0, 0x08)], model, spy, undefined, routedOf)).toThrow()
    expect(ran).toEqual([0xe8]) // a scroll command is the one exempt kind
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
    const colors: number[] = []
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) if (a(x, y)) colors.push(lum(px(x, y)))
    expect(Math.max(...colors)).toBeGreaterThan(600)
    expect(Math.min(...colors)).toBeLessThan(150)
    expect(colors.length).toBeLessThan(120)
  })

  it('is hit anywhere in its box, the clear interior included, and the screen door skips it', () => {
    const g = { orientation: 'horizontal' as const, screenCount: 1, width: 512, height: 432 }
    const sprites = [d!]
    // Local (4, 7) is clear in the bitmap (the center dot is (7, 7)): only the whole-box rule hits it.
    expect(a(4, 7)).toBe(0)
    expect(spriteAt(sprites, g, 48 + 4, 64 + 7)?.index).toBe(d!.index)
    expect(spriteAt(sprites, g, 47, 71)).toBeUndefined()
    const doors = spriteDoors({ ...g, sprites }, 0)
    expect(doors && doors.every(v => v === 0)).toBe(true)
  })

  it('draws above a high-priority tile: every lit ring pixel shows over a tile that covers the box', () => {
    const g = { orientation: 'horizontal' as const, screenCount: 1, width: 256, height: 432 }
    const planes = spritePlanes({ ...g, sprites: [d!] }, 0)
    expect(planes.sprites3).not.toBeNull()
    expect([planes.sprites0, planes.sprites1, planes.sprites2]).toEqual([null, null, null])
    const tile = new Uint8ClampedArray(g.width * g.height * 4)
    for (let i = 0; i < tile.length; i += 4) tile.set([200, 0, 0, 255], i)
    const out = composeScreen({ width: g.width, height: g.height, planes: { l1High: tile, ...planes }, lists: FALLBACK_SCREENS, math: null }) // prettier-ignore
    let lit = 0
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const at = ((64 + y) * g.width + 48 + x) * 4
        if (a(x, y)) {
          lit++
          expect(Array.from(out.subarray(at, at + 3))).not.toEqual([200, 0, 0])
        } else expect(Array.from(out.subarray(at, at + 3))).toEqual([200, 0, 0]) // the tile shows through the clear part
      }
    expect(lit).toBeGreaterThan(40)
  })
})

describe('plain words', () => {
  it('names the class, then why nothing shows, with no jargon', () => {
    const words = [
      quietText({ kind: 'shooter', name: 'Bullet Bill Shooter' }),
      quietText({ kind: 'scroll', name: 'Whatever' }),
      quietText({ kind: undefined, name: 'Some Sprite' }),
      quietText({ kind: undefined, name: undefined }),
      quietText({ kind: 'generator', name: 'Eerie Generator' }),
    ]
    expect(words[0]).toBe('Bullet Bill Shooter: fires on a timer; nothing is drawn until it does')
    expect(words[1]).toBe('Scroll command: changes how the screen scrolls; it has no picture in the game') // prettier-ignore
    expect(words[2]).toBe('Some Sprite: runs normally, but draws nothing on the map')
    expect(words[3]).toBe('Runs normally, but draws nothing on the map')
    expect(words[4]).toBe('Eerie Generator: runs in the background; it has no picture on the map')
    for (const w of words) expect(w).not.toMatch(/OAM|pass|\$|0x|github|water|fog/i)
  })

  it('a reason the Properties view has words for says why, before the generic line', () => {
    WHY_NOT_DRAWN.syntheticKey = 'Only a player action reveals it.'
    try {
      expect(quietText({ kind: undefined, name: 'Hidden Thing', reason: 'syntheticKey' })).toBe('Hidden Thing: Only a player action reveals it.') // prettier-ignore
      expect(quietText({ kind: undefined, name: undefined, reason: 'syntheticKey' })).toBe('Only a player action reveals it.') // prettier-ignore
      expect(quietText({ kind: undefined, name: 'X', reason: 'no such key' })).toMatch(/runs normally/) // prettier-ignore
    } finally {
      delete WHY_NOT_DRAWN.syntheticKey
    }
  })

  it('the hover and Properties carry it; a failed sprite keeps the old line', () => {
    const [q, f] = run([sprite(0xe8, 0), sprite(2, 1)], { 0xe8: { ok: false, reason: 'r', routed: 'scroll' }, 2: { ok: false, reason: 'refused: x' } }) // prettier-ignore
    expect(spriteName(q!)).toMatch(/^Scroll command/)
    expect(spriteProps(q!).notes[0]).toMatch(/^Scroll command: .*game\.$/)
    expect(spriteProps(f!).notes[0]).toMatch(/^Not drawn: /)
  })

  it('a routed id is not described as drawn by its own routine in the animation line', () => {
    const r = framesOf({ direct: { ok: false, reason: 'x', routed: 'shooter' } }, sprite(0xc9), model) // prettier-ignore
    expect(r.frames).toEqual([])
    const words = framesReasonText(r.reason!)
    expect(words).toBe('It has no picture on the map, so there is nothing to animate.')
    expect(words).not.toMatch(/routine/)
  })
})

// A bank-2 window carrying only the loader's opcode shapes, with operands unlike the game's. The offsets are
// the blocks' places; the hops between them are real branch displacements.
/** The branch displacement byte from `at` to `to`. */
const rel = (at: number, to: number) => (to - (at + 2)) & 0xff
// The routine's start (checked, so a hook patched over it reads unavailable), then the scroll test.
const S = 0x100
const C = 0xc0 // the loop that calls the routine (unlike operands); its branch must land on S
const LN = C + 24 // where the entry's other two skips land: the loop's step to the next sprite
const RET = 0xa0 // where the entry first skip and the loop end branch land: a return
const GUARD = 0x130 // where the scroll guard lands: the branch on to the next sprite
const ENTRY = [0xd0, rel(S, RET), 0xb7, 0x0a, 0x29, 0xf0, 0xc5, 0x00, 0xd0, rel(S + 8, LN), 0xbd, 0x00, 0x12, 0xd0, rel(S + 13, LN), 0x86, 0x02, 0xfe, 0x00, 0x12, 0xc8, 0xb7, 0x0a, 0x85, 0x05, 0x88] // prettier-ignore
const SC = S + ENTRY.length // the scroll CMP itself
const E = 0x140 // the Eeries test
const P = 0x150 // the platforms test
const G = 0x160 // the generator test
const AFTER = G + 20 // where the generator's upper-bound branch lands: the test for the cluster spawners, just past its block
const ST9 = AFTER + 16 // the carried-shell path the cluster test's below-range branch lands on
const SH = AFTER + 20 // the shooter test: right after those two blocks
const LS = 0x1000 // the shooter loader's opening, which the shooter test's call (operand $9000) must reach
const NEXT = 0x138 // where both generator and shooter paths go on: the branch to the next sprite
// The Eeries/platforms test shape with operands (compare value, saved-index cell, call target) unlike the game's,
// so no 8-byte run of the fixture is a run of the vanilla ROM (D126); the reader takes only the opcodes and the hops.
const call = (at: number, cmp: number, cell: number, to: number[], hop: number) => [
  0xc9,
  cmp,
  0xd0,
  rel(at + 2, hop),
  0x5a,
  0xda,
  0x88,
  0x84,
  cell,
  0x20,
  ...to,
]
/** A 512 KB fixture ROM whose bank 2 holds only the loader's opcode shapes, with `edit` to plant a defect. */
function cart(
  edit: (put: (at: number, bytes: number[]) => void, buf: Buffer) => void = () => undefined,
): RomFile {
  const buf = Buffer.alloc(0x80000)
  buf[0x7fd5] = 0x20
  const put = (at: number, bytes: number[]) => buf.set(bytes, 0x10000 + at)
  put(S, [...ENTRY, 0xc9, 0xa0, 0x90, rel(SC + 2, E), 0xad, 0x34, 0x12, 0x0d, 0x56, 0x12, 0xd0, rel(SC + 10, GUARD), 0x5a, 0xda, 0xa5, 0x05, 0x38, 0xe9, 0xa0, 0x8d, 0x78, 0x12]) // prettier-ignore
  put(GUARD, [0x80, rel(GUARD, LN)])
  put(RET, [0x60])
  put(C, [0xb7, 0x0a, 0xc9, 0xff, 0xf0, rel(C + 4, RET), 0x0a, 0x0a, 0x0a, 0x29, 0x10, 0x85, 0x0b, 0xc8, 0xb7, 0x0c, 0x29, 0x0f, 0x05, 0x0d, 0xc5, 0x0e, 0xb0, rel(C + 22, S), 0xc8, 0xc8, 0xe8, 0x80, rel(C + 27, C)]) // prettier-ignore
  put(AFTER, [0xc9, 0x85, 0x90, rel(AFTER + 2, ST9), 0xda, 0x5a, 0x88, 0x84, 0x0c, 0x20, 0x78, 0x94, 0x7a, 0xfa, 0x80, rel(AFTER + 14, NEXT)]) // prettier-ignore
  put(ST9, [0xa9, 0x05, 0x80, rel(ST9 + 2, SH + 11)])
  put(E, call(E, 0x73, 0x07, [0x34, 0x92], P))
  put(P, call(P, 0x77, 0x09, [0x56, 0x93], G))
  // generators 0x50..0x5f; shooters 0x4b..0x4f: a gap of 5 below the generator bound, unlike the game's.
  put(G, [0xc9, 0x50, 0x90, rel(G + 2, SH), 0xc9, 0x60, 0xb0, rel(G + 6, AFTER), 0x38, 0xe9, 0x50, 0x1a, 0x8d, 0x9a, 0x12, 0x9e, 0x11, 0x12, 0x80, rel(G + 18, NEXT)]) // prettier-ignore
  put(SH, [0xc9, 0x4b, 0x90, 0x05, 0x20, 0x00, 0x90, 0x80, rel(SH + 7, NEXT), 0xa9, 0x01])
  put(NEXT, [0x80, rel(NEXT, LN)])
  put(LS, [0x86, 0x09, 0x88, 0x84, 0x0a, 0x85, 0x0b, 0xa2, 0x05, 0xbd, 0x11, 0x14, 0xf0, 0x0e, 0xca, 0x10, 0xf4]) // prettier-ignore
  edit(put, buf)
  return RomFile.fromBytes('x.sfc', buf)
}
/** The unavailable reason for a ROM's loader read, or 'ok'. */
const reasonOf = (rom: RomFile) => {
  const r = loadClasses(rom)
  return r.status === 'unavailable' ? r.reason : 'ok'
}

/** Each planted defect, the loader read it must break, and the reason it must give: one test per gate. */
const GATES: [string, (put: (at: number, b: number[]) => void) => void, RegExp][] = [
  [
    'scroll subtract differs from compare',
    put => put(SC + 18, [0xa1]),
    /scroll test and the command number/,
  ],
  [
    'generator subtract differs from compare',
    put => put(G + 10, [0x51]),
    /generator test and the number/,
  ],
  ['generator low branch elsewhere', put => put(G + 3, [0x20]), /hand lower ids to the shooter/],
  [
    'generator upper-bound branch into the generator path',
    put => put(G + 7, [0x00]),
    /upper bound does not skip/,
  ],
  [
    'generator upper-bound branch elsewhere',
    put => put(G + 7, [0x30]),
    /upper bound does not skip/,
  ],
  ['generator skip-on hop elsewhere', put => put(G + 19, [0x00]), /go on to the next sprite/],
  ['shooter skip-on hop elsewhere', put => put(SH + 8, [0x00]), /go on to the next sprite/],
  ['Eeries test takes a shooter-band id', put => put(E + 1, [0x4c]), /Eeries or platform test/],
  ['platform test takes a generator-band id', put => put(P + 1, [0x52]), /Eeries or platform test/],
  [
    'Eeries test takes the scroll bound itself',
    put => put(E + 1, [0xa0]),
    /Eeries or platform test/,
  ],
  ['caller branch redirected away from the routine', put => put(C + 23, [0x00]), /caller loop/],
  ['caller loop missing', put => put(C, [0xea]), /caller loop/],
  ['caller loop end-of-list branch elsewhere', put => put(C + 5, [0x00]), /caller loop/],
  ['caller loop does not repeat', put => put(C + 28, [0x00]), /caller loop/],
  [
    'entry skips land somewhere other than the caller loop step',
    put => (put(S + 9, [rel(S + 8, GUARD)]), put(S + 14, [rel(S + 13, GUARD)])),
    /load start does not skip/,
  ],
  [
    'generator upper bound lands on a missing cluster test',
    put => put(AFTER, [0xea]),
    /upper-bound path/,
  ],
  ['cluster test below-range branch elsewhere', put => put(AFTER + 3, [0x00]), /upper-bound path/],
  ['cluster test tail goes elsewhere', put => put(AFTER + 15, [0x00]), /upper-bound path/],
  ['carried-shell path goes elsewhere', put => put(ST9 + 3, [0x00]), /upper-bound path/],
  [
    'shooter test relocated, everything else relinked',
    put => {
      const SH2 = SH + 8
      put(SH, new Array(11).fill(0))
      put(SH2, [0xc9, 0x4b, 0x90, 0x05, 0x20, 0x00, 0x90, 0x80, rel(SH2 + 7, NEXT), 0xa9, 0x01])
      put(G + 3, [rel(G + 2, SH2)])
      put(ST9 + 3, [rel(ST9 + 2, SH2 + 11)])
    },
    /upper-bound path/,
  ],
  ['carried-shell path missing', put => put(ST9, [0xea]), /upper-bound path/],
  [
    'shooter call repointed to another routine',
    put => put(SH + 5, [0x00, 0x91]),
    /shooter test calls/,
  ],
  ['shooter call points past the bank', put => put(SH + 5, [0xfe, 0xff]), /shooter test calls/],
  [
    'shooter loader opening cut off by the end of the bank',
    // 16 of its 17 bytes fit; the last is a wildcard that would "match" off the end if reads were not bounded
    put => (
      put(
        0x7ff0,
        [
          0x86, 0x09, 0x88, 0x84, 0x0a, 0x85, 0x0b, 0xa2, 0x05, 0xbd, 0x11, 0x14, 0xf0, 0x0e, 0xca,
          0x10,
        ],
      ),
      put(SH + 5, [0xf0, 0xff])
    ),
    /shooter test calls/,
  ],
  ['shooter call points below the bank', put => put(SH + 5, [0x00, 0x40]), /shooter test calls/],
  [
    'entry skips land on the first byte of the Eeries test',
    put => (put(S + 9, [rel(S + 8, E)]), put(S + 14, [rel(S + 13, E)])),
    /load start does not skip/,
  ],
  [
    'entry first skip lands on a return byte inside a matched shape',
    put => (put(S + 3, [0x60]), put(S + 1, [rel(S, S + 3)])),
    /load start does not skip/,
  ],
  ['the next-sprite branch is not a branch', put => put(NEXT, [0xea]), /go on to the next sprite/],
  [
    'the next-sprite branch goes nowhere (displacement 0)',
    put => put(NEXT + 1, [0x00]),
    /go on to the next sprite/,
  ],
  [
    'scroll guard goes backward to a branch before the scroll test',
    put => (put(0xb8, [0x80, rel(0xb8, LN)]), put(SC + 11, [rel(SC + 10, 0xb8)])),
    /guard does not skip/,
  ],
  ['scroll guard branch goes elsewhere', put => put(GUARD + 1, [0x00]), /guard does not skip/],
  [
    'scroll guard lands on the first byte of the store operand',
    put => (put(SC + 20, [0x80, rel(SC + 20, LN)]), put(SC + 11, [rel(SC + 10, SC + 20)])),
    /guard does not skip/,
  ],
  ['entry first skip is not a return', put => put(RET, [0xea]), /load start does not skip/],
  [
    'entry skips land in different places',
    put => put(S + 14, [rel(S + 13, LN + 2)]),
    /load start does not skip/,
  ],
  [
    'entry skips both land inside the routine',
    put => (put(S + 9, [rel(S + 8, S + 0x20)]), put(S + 14, [rel(S + 13, S + 0x20)])),
    /load start does not skip/,
  ],
  ['scroll guard lands off a branch', put => put(GUARD, [0xea]), /guard does not skip/],
  [
    'scroll guard lands on a branch before its store',
    put => (put(S + 3, [0x80]), put(SC + 11, [rel(SC + 10, S + 3)])),
    /guard does not skip/,
  ],
  ['shooter low branch elsewhere', put => put(SH + 3, [0x06]), /hand lower ids on/],
  ['scroll branch elsewhere', put => put(SC + 3, [0x10]), /does not lead through/],
  ['Eeries branch elsewhere', put => put(E + 3, [0x02]), /does not lead through/],
  ['platforms branch elsewhere', put => put(P + 3, [0x02]), /does not lead through/],
  ['shooter bound not below generator', put => put(SH + 1, [0x55]), /not in an order/],
  ['generator end past the scroll bound', put => put(G + 5, [0xb0]), /Eeries or platform test/],
]

/** Positions are written out here, not walked from SHAPES: nulling an opcode in the code under test must fail these. */
const OPCODES: Record<string, { at: number[]; idx: number[] }> = {
  scroll: { at: [S], idx: [0, 2, 4, 5, 6, 8, 10, 13, 15, 17, 20, 21, 23, 25, 26, 28, 30, 33, 36, 38, 39, 40, 42, 43, 45] }, // prettier-ignore
  loaderCall: { at: [E, P], idx: [0, 2, 4, 5, 6, 7, 9] },
  generator: { at: [G], idx: [0, 2, 4, 6, 8, 9, 11, 12, 15, 18] },
  shooter: { at: [SH], idx: [0, 2, 4, 7, 9] },
  loadShooter: { at: [LS], idx: [0, 2, 3, 5, 7, 9, 12, 14, 15] },
  caller: {
    at: [C],
    idx: [0, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13, 14, 16, 17, 18, 20, 22, 24, 25, 26, 27],
  },
  cluster: { at: [AFTER], idx: [0, 2, 4, 5, 6, 7, 9, 12, 13, 14] },
  status9: { at: [ST9], idx: [0, 2] },
}
/** One case per opcode position, copy and change (a flip and a near-miss), each its own test. */
const OPCODE_CASES: [string, number, number, number][] = Object.entries(OPCODES).flatMap(
  ([name, { at, idx }]) =>
    at.flatMap(base =>
      idx.flatMap(i =>
        [0xff, 0x04].map(
          c =>
            [`${name}[${i}] at $${base.toString(16)} ^$${c.toString(16)}`, base, i, c] as [
              string,
              number,
              number,
              number,
            ],
        ),
      ),
    ),
)

describe('LoadClass reads the loader from its operands', () => {
  it('classes follow the planted bounds, not the game values or a fixed gap', () => {
    const r = loadClasses(cart())
    if (r.status !== 'ok') throw new Error(r.reason)
    const ids = [0x10, 0x4a, 0x4b, 0x4f, 0x50, 0x5f, 0x60, 0x9f, 0xa0, 0xff]
    expect(ids.map(r.of)).toEqual(['normal', 'normal', 'shooter', 'shooter', 'generator', 'generator', 'normal', 'normal', 'scroll', 'scroll']) // prettier-ignore
    // A shooter bound taken as the generator bound minus 2 would call 0x4e shooter and 0x4b normal.
    expect([0x4b, 0x4c, 0x4d].map(r.of)).toEqual(['shooter', 'shooter', 'shooter'])
  })

  it.each(GATES)('gate: %s', (_name, edit, why) => {
    expect(reasonOf(cart(edit))).toMatch(why)
  })

  it('the unplanted fixture reads ok', () => {
    expect(reasonOf(cart())).toBe('ok')
  })

  it.each(OPCODE_CASES)(
    'opcode %s: a flip or a near-miss makes the read unavailable',
    (_title, base, i, change) => {
      const rom = cart((_put, buf) => (buf[0x10000 + base + i]! ^= change))
      expect(reasonOf(rom)).not.toBe('ok')
    },
  )

  it('the opcode positions are exactly the non-operand bytes of the shapes, and every one is a case', () => {
    expect(OPCODE_CASES.length).toBe(2 * (25 + 2 * 7 + 10 + 5 + 9 + 21 + 10 + 2))
    for (const [name, shape] of Object.entries(SHAPES))
      expect(
        shape.flatMap((w, i) => (w === null ? [] : [i])),
        name,
      ).toEqual(OPCODES[name]!.idx)
  })

  it('the order gate is exact: generator end above its start, with room before the scroll bound for the Eeries and platform ids', () => {
    expect(reasonOf(cart(put => put(G + 5, [0x50])))).toMatch(/not in an order/) // end == start
    expect(reasonOf(cart(put => put(G + 5, [0x40])))).toMatch(/not in an order/) // end < start
    expect(reasonOf(cart(put => put(G + 5, [0xa0])))).toMatch(/Eeries or platform test/) // end == scroll bound: no room left
    expect(reasonOf(cart(put => put(G + 5, [0xa1])))).toMatch(/Eeries or platform test/)
    expect(reasonOf(cart(put => put(G + 5, [0x74])))).toMatch(/Eeries or platform test/) // end below the ids the two tests take
    expect(reasonOf(cart(put => put(SH + 1, [0x50])))).toMatch(/not in an order/) // shooter start == generator start
  })

  it('a backward branch in the chain is followed as a signed displacement', () => {
    // The Eeries test moves ahead of the scroll test: the scroll test's branch goes backward.
    const E2 = 0xe0
    const moved = (put: (at: number, b: number[]) => void) => {
      put(E2, call(E2, 0x73, 0x07, [0x34, 0x92], P))
      put(SC + 3, [rel(SC + 2, E2)])
    }
    expect(reasonOf(cart(moved))).toBe('ok')
    expect(reasonOf(cart((put, buf) => (moved(put), put(SC + 3, [buf[0x10000 + SC + 3]! ^ 0x01]))))).toMatch(/does not lead through/) // prettier-ignore
  })

  it('a hook patched over the routine start reads unavailable', () => {
    expect(reasonOf(cart(put => put(S, [0x5c, 0x00, 0x90, 0x02])))).toMatch(
      /routine start before the scroll test/,
    ) // a JML over the entry
  })
  it('a second copy of a shape makes the read ambiguous (first of many is not taken)', () => {
    const second = (put: (at: number, b: number[]) => void) => put(0x400, [0xc9, 0x77, 0x90, 0x10, 0xc9, 0x78, 0xb0, 0x20, 0x38, 0xe9, 0x77, 0x1a, 0x8d, 0x00, 0x12, 0x9e, 0x01, 0x12, 0x80, 0x04]) // prettier-ignore
    expect(reasonOf(cart(second))).toMatch(/generator test was found 2 times/)
    const shooter2 = (put: (at: number, b: number[]) => void) => put(0x400, [0xc9, 0x77, 0x90, 0x05, 0x20, 0x00, 0x90, 0x80, 0x02, 0xa9, 0x01]) // prettier-ignore
    expect(reasonOf(cart(shooter2))).toMatch(/shooter test was found 2 times/)
  })

  it('refuses a cart with no loader at all', () => {
    expect(loadClasses(RomFile.fromBytes('x.sfc', Buffer.alloc(0x80000)))).toMatchObject({ status: 'unavailable' }) // prettier-ignore
  })
})

describe('the runner routes by what LoadClass read, with no fallback to the game bands', () => {
  const seedFor = () => withSeed({ loaded: new Uint8Array(0x2000) })
  const geometry = { isVertical: false, screenCount: 1 }
  /** A real interpDrawer over the fixture ROM with a spy run that records which ids ran as sprites. */
  const drawerFor = (rom: RomFile, ran: number[]) =>
    interpDrawer(
      rom,
      0,
      geometry,
      (_r, id) => (ran.push(id), runModel({ refusal: 'spy' })),
      seedFor,
    )

  it('routes the planted shooter and scroll bands without running sprite code; the game bands run as sprites', () => {
    const ran: number[] = []
    const d = drawerFor(cart(), ran)
    expect(d(sprite(0x4b))).toMatchObject({ ok: false, routed: 'shooter' })
    expect(d(sprite(0x55))).toMatchObject({ ok: false, routed: 'generator' })
    expect(d(sprite(0xa0))).toMatchObject({ ok: false, routed: 'scroll' })
    expect(ran).toEqual([])
    // 0x70 is in no planted band, so it runs as a sprite.
    d(sprite(0x70))
    expect(ran).toEqual([0x70])
  })

  it('an unreadable loader routes nothing: the game bands are not assumed', () => {
    const ran: number[] = []
    const d = drawerFor(
      cart(put => put(SH, [0xea, 0xea])),
      ran,
    )
    d(sprite(0xe8))
    d(sprite(0xc9))
    expect(ran).toEqual([0xe8, 0xc9])
  })
})

describe('review findings (#1273)', () => {
  it('loadClasses re-reads after a write to the same ROM: the cache is keyed on the version', () => {
    const rom = cart()
    expect(reasonOf(rom)).toBe('ok')
    rom.writeAt(0x028000 + SC + 18, [0xa1]) // the scroll subtract no longer matches its compare
    expect(reasonOf(rom)).toMatch(/scroll test and the command number/)
    rom.writeAt(0x028000 + SC + 18, [0xa0]) // and back: read again, ok again
    expect(reasonOf(rom)).toBe('ok')
  })

  it('a shooter with no sprite name still gets the timer words, not the generic line', () => {
    expect(quietText({ kind: 'shooter', name: undefined })).toBe('Shooter: fires on a timer; nothing is drawn until it does') // prettier-ignore
  })

  it('an empty run whose loader routing could not be read is unverified (so it keeps the box), unless it can be read', () => {
    const seedFor = () => withSeed({ loaded: new Uint8Array(0x2000) })
    const geometry = { isVertical: false, screenCount: 1 }
    const empty = () => runModel({ emptyReason: 'drew no OAM tile' })
    const unreadable = interpDrawer(
      cart(put => put(SH, [0xea, 0xea])),
      0,
      geometry,
      empty,
      seedFor,
    )
    const r = unreadable(sprite(0x70))
    expect(r).toMatchObject({ ok: false, empty: true, unverified: expect.stringContaining('routing could not be read') }) // prettier-ignore
    expect(drawSprites([sprite(0x70)], model, () => r, undefined, undefined)[0]!.status).toBe(
      'placeholder',
    )
    // A reason already there is kept, not replaced.
    const kept = interpDrawer(cart(put => put(SH, [0xea, 0xea])), 0, geometry, () => runModel({ emptyReason: 'x', unverifiedReason: 'seed lacks state' }), seedFor)(sprite(0x70)) // prettier-ignore
    expect(kept).toMatchObject({ unverified: expect.stringContaining('seed lacks state') })
    // Readable routing: the empty run is verified, so quiet.
    const readable = interpDrawer(cart(), 0, geometry, empty, seedFor)(sprite(0x70))
    expect(readable).toMatchObject({ ok: false, empty: true })
    expect('unverified' in readable).toBe(false)
  })
})

describe('with the plain unverified note (#1166)', () => {
  const stream = Uint8Array.from([0, 0x00, 0x01, 0x10, 0x00, 0x02, 0x11, 0xff]) // two entries, ids $10 and $11
  const m = { ...model, isVertical: false, screenCount: 1 }
  const drawn = (res: Record<number, SpriteDrawResult>) => spriteLayer(stream, m, draw(res))

  it('a quiet sprite keeps its note and is not counted as unverified; a box with a reason gets the plain line and the raw text', () => {
    const quiet: SpriteDrawResult = { ok: false, reason: 'drew no OAM tile', empty: true }
    const unverified: SpriteDrawResult = { ok: false, reason: 'drew no OAM tile', empty: true, unverified: "the loader's id routing could not be read (x)" } // prettier-ignore
    const r = drawn({ 0x10: quiet, 0x11: unverified })
    const [q, u] = r.sprites
    expect([q!.status, u!.status]).toEqual(['quiet', 'placeholder'])
    expect(r.note).toBe('Unverified: 1 sprite may not be drawn exactly as in the game.') // only the box counts
    expect(spriteProps(q!).notes[0]).toMatch(/draws nothing on the map\.$/)
    expect(spriteProps(q!).notes).not.toContain(UNVERIFIED_NOTE)
    const p = spriteProps(u!)
    expect(p.notes).toContain(UNVERIFIED_NOTE)
    expect(noteTitle(UNVERIFIED_NOTE, p)).toBe("the loader's id routing could not be read (x)")
  })
})
