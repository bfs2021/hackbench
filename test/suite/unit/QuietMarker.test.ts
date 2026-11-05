/**
 * The quiet marker (#1011): a verdict, never an id list. All synthetic, so CI (no ROM) runs it; the vanilla
 * corpus cases are in QuietMarker.corpus.test.ts.
 */
import { describe, it, expect } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { composeScreen } from '../../../src/rom/model/ColorMath'
import { FALLBACK_SCREENS } from '../../../src/rom/model/ScreenPlanes'
import { loadClasses, type LoadClass } from '../../../src/rom/sprites/interp/LoadClass'
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

// An invented loader routine at the game's call site, table driven and unlike the game's: it reads the id from the list,
// looks up a class code in a test table and stores a value in the cell of that class. Nothing here rebuilds game code (D126).
const SITE = 0x028b1d
const ROUTINE = 0x029000
const TABLE = 0x029100
const SCROLL_CELL = 0x143e
const GEN_CELL = 0x18b9
const SHOOT_CELL = 0x1785
const [NORMAL, SHOOT, GEN, SCROLL] = [0, 1, 2, 3]
/** Which class code a table byte holds for an id: shooters 0x30-0x33, generators 0x40-0x4f, scroll commands 0x90 up. */
const BANDS = (id: number) => (id >= 0x90 ? SCROLL : id >= 0x40 && id < 0x50 ? GEN : id >= 0x30 && id < 0x34 ? SHOOT : NORMAL) // prettier-ignore
/** What the routine stores: the id (steps with it), the id minus a constant, or the class code (does not step). */
type Store = 'id' | 'offset' | 'flat'
interface Plan {
  classes?: (id: number) => number
  store?: Partial<Record<number, Store>>
  /** What a normal id's path does: the default returns. */
  normal?: number[]
  /** Run the rest of the routine in the $82 mirror of the bank. */
  mirror?: boolean
  /** What follows a store; the default returns, and a run that stops at the store never reaches it. */
  afterStore?: number[]
}
const RTS = 0x60
/** A 512 KB LoROM cart whose call site calls the invented routine; `edit` plants a defect after the build. */
function cart(
  plan: Plan = {},
  edit: (put: (at: number, b: number[]) => void) => void = () => undefined,
): RomFile {
  // prettier-ignore
  const buf = Buffer.alloc(0x80000)
  buf[0x7fd5] = 0x20
  const put = (at: number, bytes: number[]) =>
    buf.set(bytes, (at & 0x7fff) + ((at >> 16) & 0x3f) * 0x8000)
  const value = (s: Store) => (s === 'id' ? [0x8a] : s === 'offset' ? [0x8a, 0x38, 0xe9, 0x07] : [])
  const tail = (code: number, cell: number) => [
    ...value(plan.store?.[code] ?? 'id'),
    0x8d,
    cell & 0xff,
    cell >> 8,
    ...(plan.afterStore ?? [RTS]),
  ]
  const [shoot, gen, scroll] = [
    tail(SHOOT, SHOOT_CELL),
    tail(GEN, GEN_CELL),
    tail(SCROLL, SCROLL_CELL),
  ]
  const jump = (ROUTINE & 0xffff) + 6 // the mirror's jump lands on the lookup, which starts right after it
  const head = [0xa5, 0x14, ...(plan.mirror ? [0x5c, jump & 0xff, jump >> 8, 0x82] : [])]
  const normal = plan.normal ?? [RTS]
  const lookup = [0xa0, 0x03, 0xb7, 0xce, 0xaa, 0xbf, TABLE & 0xff, (TABLE >> 8) & 0xff, 0x02]
  const tests = (code: number, to: number) => [0xc9, code, 0xf0, to]
  const base = lookup.length + 12 + normal.length // the first tail starts after three tests and the normal path
  const at = [base, base + shoot.length, base + shoot.length + gen.length]
  const branches = [SHOOT, GEN, SCROLL].flatMap((code, i) => tests(code, at[i]! - (lookup.length + 4 * (i + 1)))) // prettier-ignore
  put(SITE, [0x20, ROUTINE & 0xff, (ROUTINE >> 8) & 0xff])
  put(ROUTINE, new Array(0x100).fill(0x4b)) // filler after the code, never run
  put(ROUTINE, [...head, ...lookup, ...branches, ...normal, ...shoot, ...gen, ...scroll])
  put(
    TABLE,
    Array.from({ length: 256 }, (_, id) => (plan.classes ?? BANDS)(id)),
  )
  edit(put)
  return RomFile.fromBytes('x.sfc', buf)
}
/** The unavailable reason for a ROM's loader read, or 'ok'. */
const reasonOf = (rom: RomFile) => {
  const r = loadClasses(rom)
  return r.status === 'unavailable' ? r.reason : 'ok'
}
/** Class codes with a run of ids moved: the shooter ids in two pieces, a generator band below the shooters, or a hole in the scroll ids. */
const withGap = (id: number) => (id === 0x32 ? NORMAL : BANDS(id))
const generatorsFirst = (id: number) => (id >= 0x10 && id < 0x20 ? GEN : id >= 0x30 && id < 0x34 ? SHOOT : BANDS(id) === GEN ? NORMAL : BANDS(id)) // prettier-ignore
const scrollHole = (id: number) => (id === 0xc0 ? NORMAL : BANDS(id))

describe('LoadClass runs the loader and reads the class from what it writes', () => {
  it.each([
    [0x00, 'normal'],
    [0x2f, 'normal'],
    [0x30, 'shooter'],
    [0x33, 'shooter'],
    [0x34, 'normal'],
    [0x40, 'generator'],
    [0x4f, 'generator'],
    [0x50, 'normal'],
    [0x8f, 'normal'],
    [0x90, 'scroll'],
    [0xff, 'scroll'],
  ] as [number, LoadClass][])('routes id $%s as %s', (id, want) => {
    const r = loadClasses(cart())
    if (r.status !== 'ok') throw new Error(r.reason)
    expect(r.of(id)).toBe(want)
  })

  it('a value that steps with the id from a constant offset is accepted', () => {
    expect(reasonOf(cart({ store: { [SCROLL]: 'offset', [GEN]: 'offset', [SHOOT]: 'offset' } }))).toBe('ok') // prettier-ignore
  })

  it('a return through the other bank mirror counts as a return', () => {
    expect(reasonOf(cart({ mirror: true }))).toBe('ok')
  })

  it.each([
    [
      'the call site is not a JSR',
      cart({}, put => put(SITE, [0xea])),
      /does not call the level loader/,
    ],
    ['the target does not open with a direct-page load', cart({}, put => put(ROUTINE, [0xea])), /does not open the way/], // prettier-ignore
    ['a normal id hits BRK', cart({ normal: [0x00] }), /id \$00: BRK executed/],
    [
      'a normal id leaves ROM',
      cart({ normal: [0x5c, 0x00, 0x00, 0x7e] }),
      /id \$00: execution left ROM/,
    ],
    ['a normal id never returns', cart({ normal: [0x80, 0xfe] }), /id \$00: did not return within/],
    [
      'a normal id returns with the stack off',
      cart({ normal: [0x48, RTS] }),
      /id \$00: returned with the stack/,
    ],
    ['a stray pop in the mirror bank keeps running', cart({ mirror: true, normal: [0xc2, 0x20, 0x68, 0xea, RTS] }), /id \$00: returned with the stack/], // prettier-ignore
    ['the shooter ids have a gap', cart({ classes: withGap }), /shooter ids are not one run/],
    ['the generators come before the shooters', cart({ classes: generatorsFirst }), /shooter ids do not come after|generator ids do not come after/], // prettier-ignore
    ['the scroll ids have a hole', cart({ classes: scrollHole }), /scroll ids are not one run/],
    ['the shooter value does not step with the id', cart({ store: { [SHOOT]: 'flat' } }), /shooter value does not step/], // prettier-ignore
    ['the generator value does not step with the id', cart({ store: { [GEN]: 'flat' } }), /generator value does not step/], // prettier-ignore
    ['the scroll value does not step with the id', cart({ store: { [SCROLL]: 'flat' } }), /scroll value does not step/], // prettier-ignore
  ] as [string, RomFile, RegExp][])('unavailable when %s', (_title, rom, why) => {
    expect(reasonOf(rom)).toMatch(why)
  })

  it('a ROM with no loader at all is unavailable', () => {
    expect(loadClasses(RomFile.fromBytes('x.sfc', Buffer.alloc(0x80000)))).toMatchObject({ status: 'unavailable' }) // prettier-ignore
  })
})

describe('LoadClass caches by the bytes the runs read', () => {
  it('an edit to a byte the run read recomputes; an edit to one it never read keeps the same answer', () => {
    const rom = cart()
    const first = loadClasses(rom)
    rom.writeAt(TABLE + 0x34, [SHOOT]) // id $34 is read by its run, and extends the shooter band
    const edited = loadClasses(rom)
    expect(edited).not.toBe(first)
    if (edited.status !== 'ok') throw new Error('unavailable')
    expect(edited.of(0x34)).toBe('shooter')
    rom.writeAt(0x02f000, [0x12]) // nothing reads it
    expect(loadClasses(rom)).toBe(edited)
  })

  it('a new RomFile of the same bytes shares the answer (the working copy hands out a new one per call)', () => {
    expect(loadClasses(cart())).toBe(loadClasses(cart()))
  })

  it('the run stops at the first write to a cell: a BRK after the store is never reached', () => {
    expect(reasonOf(cart({ afterStore: [0x00] }))).toBe('ok')
  })

  it('the first write decides: a later write to another cell changes nothing', () => {
    const r = loadClasses(cart({ afterStore: [0x8d, SCROLL_CELL & 0xff, SCROLL_CELL >> 8, RTS] }))
    if (r.status !== 'ok') throw new Error(r.reason)
    expect([0x31, 0x45, 0x95].map(r.of)).toEqual(['shooter', 'generator', 'scroll'])
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
    expect(d(sprite(0x31))).toMatchObject({ ok: false, routed: 'shooter' })
    expect(d(sprite(0x45))).toMatchObject({ ok: false, routed: 'generator' })
    expect(d(sprite(0xa0))).toMatchObject({ ok: false, routed: 'scroll' })
    expect(ran).toEqual([])
    // 0x70 is in no planted band, so it runs as a sprite.
    d(sprite(0x70))
    expect(ran).toEqual([0x70])
  })

  it('an unreadable loader routes nothing: the game bands are not assumed', () => {
    const ran: number[] = []
    const d = drawerFor(
      cart({}, put => put(SITE, [0xea])),
      ran,
    )
    d(sprite(0xe8))
    d(sprite(0xc9))
    expect(ran).toEqual([0xe8, 0xc9])
  })
})

describe('review findings (#1273)', () => {
  it('a shooter with no sprite name still gets the timer words, not the generic line', () => {
    expect(quietText({ kind: 'shooter', name: undefined })).toBe('Shooter: fires on a timer; nothing is drawn until it does') // prettier-ignore
  })

  it('an empty run whose loader routing could not be read is unverified (so it keeps the box), unless it can be read', () => {
    const seedFor = () => withSeed({ loaded: new Uint8Array(0x2000) })
    const geometry = { isVertical: false, screenCount: 1 }
    const empty = () => runModel({ emptyReason: 'drew no OAM tile' })
    const unreadable = interpDrawer(
      cart({}, put => put(SITE, [0xea])),
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
    const kept = interpDrawer(cart({}, put => put(SITE, [0xea])), 0, geometry, () => runModel({ emptyReason: 'x', unverifiedReason: 'seed lacks state' }), seedFor)(sprite(0x70)) // prettier-ignore
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
