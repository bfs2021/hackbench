/**
 * What the game's own level load does with a sprite-list entry (#1011): most ids fill a slot and run as a sprite, but the
 * loader sends a shooter, a generator and a scroll command elsewhere, and none has a sprite of its own to draw
 * (SMWDisX bank_02.asm:5290-5368; the shooter dispatch is 6831-6832).
 *
 * The class bounds are read from the compare operands of that routine, never held as constants here
 * (.claude/rules/rom-interpretation.md). Each test is found by its opcode shape in bank 2, must match exactly once, and
 * must be LINKED as the game chains them: scroll to Eeries to platforms to generator to shooter to the slot loader, each by
 * the branch's own destination. The scroll test must also sit behind the routine's first instructions, so a hook over that
 * start, or a dead copy of the shapes, reads `unavailable`. Every exit toward the next sprite must resolve to ONE proven
 * place and land outside every matched shape. The shooter test's call must reach the shooter loader's opening
 * instructions. Anything else is `status: 'unavailable'` with the reason, and the caller then runs the id as a sprite.
 * Not checked: the Eeries and platform calls' targets (those ids are never given a class, so a repointed call cannot make
 * one wrong), and what reaches the routine's first instruction (the loop that calls it has no ROM address that is not itself
 * a constant), so a patch that diverts control before it, to a copy elsewhere, is not seen.
 */
import type { RomFile } from '../../RomFile'

export type LoadClass = 'normal' | 'shooter' | 'generator' | 'scroll'

export type LoadClasses =
  { status: 'ok'; of: (id: number) => LoadClass } | { status: 'unavailable'; reason: string }

const BANK2 = 0x028000
// null matches any byte (an operand or a branch displacement); the rest are opcodes.
/** The entry's fall-through into the scroll test: skip unless at the screen boundary and not loaded yet, mark loaded, store the number. */
const ENTRY = [0xd0, null, 0xb7, null, 0x29, 0xf0, 0xc5, null, 0xd0, null, 0xbd, null, null, 0xd0, null, 0x86, null, 0xfe, null, null, 0xc8, 0xb7, null, 0x85, null, 0x88] // prettier-ignore
/** Then CMP, BCC, the scroll-command store. */
const SCROLL = [...ENTRY, 0xc9, null, 0x90, null, 0xad, null, null, 0x0d, null, null, 0xd0, null, 0x5a, 0xda, 0xa5, null, 0x38, 0xe9, null, 0x8d, null, null] // prettier-ignore
/** The Eeries and platforms tests: CMP, BNE past a call that saves X and Y. */
const LOADER_CALL = [0xc9, null, 0xd0, null, 0x5a, 0xda, 0x88, 0x84, null, 0x20, null, null] // prettier-ignore
/** Compare, below-range branch, upper compare, upper-bound branch, the generator number store, free the slot, skip to the next sprite. */
const GENERATOR = [0xc9, null, 0x90, null, 0xc9, null, 0xb0, null, 0x38, 0xe9, null, 0x1a, 0x8d, null, null, 0x9e, null, null, 0x80, null] // prettier-ignore
const SHOOTER = [0xc9, null, 0x90, null, 0x20, null, null, 0x80, null, 0xa9] // prettier-ignore
/** The shooter loader's opening: save the entry, index and number, start the slot search over the shooter table. */
const LOAD_SHOOTER = [0x86, null, 0x88, 0x84, null, 0x85, null, 0xa2, null, 0xbd, null, null, 0xf0, null, 0xca, 0x10, null] // prettier-ignore
export const SHAPES = { scroll: SCROLL, loaderCall: LOADER_CALL, generator: GENERATOR, shooter: SHOOTER, loadShooter: LOAD_SHOOTER } // prettier-ignore

// Byte offsets inside the shapes, named (SCROLL ones count from the scroll CMP, after ENTRY).
const SKIP_A = 8 // entry: the second skip branch
const SKIP_B = 13 // entry: the third skip branch
const SC_BCC = 2 // scroll test: below-range branch
const SC_GUARD = 10 // scroll test: guard over the store
const SC_SUB = 18 // scroll test: the subtracted number
const GEN_LOW = 1 // generator test: lower bound
const GEN_BCC = 2 // generator test: below-range branch
const GEN_HIGH = 5 // generator test: upper bound
const GEN_BCS = 6 // generator test: upper-bound branch
const GEN_SUB = 10 // generator test: the subtracted number
const GEN_TAIL = 18 // generator test: skip-on branch
const SH_BCC = 2 // shooter test: below-range branch
const SH_JSR = 4 // shooter test: call to the shooter loader
const SH_BRA = 7 // shooter test: skip-on branch
const SH_PAST = 9 // shooter test: where the below-range branch lands

/** An unreadable loader, with the reason. */
const fail = (reason: string): LoadClasses => ({ status: 'unavailable', reason })
/** Whether the opcode shape `want` (null matches any byte) sits at `at`. */
const matches = (code: Uint8Array, at: number, want: (number | null)[]) =>
  at >= 0 &&
  at + want.length <= code.length &&
  want.every((w, k) => w === null || code[at + k] === w)

/** Every place in `code` the shape matches. */
function find(code: Uint8Array, want: (number | null)[]): number[] {
  const hits: number[] = []
  for (let i = 0; i + want.length <= code.length; i++) if (matches(code, i, want)) hits.push(i)
  return hits
}

/** The byte at `i`, or -1 past either end of the bank (so every comparison on it fails and the read refuses). */
const byteAt = (code: Uint8Array, i: number) => code[i] ?? -1

/** Where the branch whose opcode is at `at` lands (a displacement off the end of the bank lands nowhere useful). */
const target = (code: Uint8Array, at: number) => {
  const d = byteAt(code, at + 1)
  return at + 2 + (d < 0x80 ? d : d - 0x100)
}

/** Per ROM and `version`: a `writeAt` to the same instance makes the read happen again. */
const cache = new WeakMap<RomFile, { version: number; result: LoadClasses }>()

/** The game's own routing of a sprite-list id, read from this ROM (or why it cannot be read). */
export function loadClasses(rom: RomFile): LoadClasses {
  const hit = cache.get(rom)
  if (hit && hit.version === rom.version) return hit.result
  const result = read(rom)
  cache.set(rom, { version: rom.version, result })
  return result
}

/** Reads the three class bounds from bank 2 and checks the chain that links them. */
function read(rom: RomFile): LoadClasses {
  const code = rom.readAt(BANK2, 0x8000)
  if (!code) return fail('bank 2 of the ROM could not be read')
  const b = (i: number) => byteAt(code, i)
  /** The one place a shape matches, or the reason it does not match exactly once. */
  const once = (name: string, shape: (number | null)[]): number | string => {
    const hits = find(code, shape)
    if (hits.length === 1) return hits[0]!
    // The scroll test alone is there but the routine start before it is not: a hook may cover that start.
    if (name === 'scroll' && find(code, shape.slice(ENTRY.length)).length === 1)
      return "the level loader's routine start before the scroll test is not the loader's (a hook may cover it)"
    return `the level loader's ${name} test was found ${hits.length} times, so which one runs is unknown`
  }
  const found = [once('scroll', SCROLL), once('generator', GENERATOR), once('shooter', SHOOTER)]
  for (const x of found) if (typeof x === 'string') return fail(x)
  const [s, ge, sh] = found as number[]
  const sc = s! + ENTRY.length // the scroll CMP itself
  const [scrollFrom, genFrom, genTo, shootFrom] = [
    b(sc + 1),
    b(ge! + GEN_LOW),
    b(ge! + GEN_HIGH),
    b(sh! + 1),
  ]
  if (b(sc + SC_SUB) !== scrollFrom)
    return fail('the scroll test and the command number it subtracts differ')
  if (b(ge! + GEN_SUB) !== genFrom)
    return fail('the generator test and the number it subtracts differ')
  // The chain the game walks, each hop by the branch's own destination.
  const eeries = target(code, sc + SC_BCC)
  const platforms = target(code, eeries + 2)
  if (
    !matches(code, eeries, LOADER_CALL) ||
    !matches(code, platforms, LOADER_CALL) ||
    target(code, platforms + 2) !== ge
  )
    return fail(
      'the scroll test does not lead through the Eeries and platform tests to the generator test',
    )
  if (target(code, ge! + GEN_BCC) !== sh)
    return fail('the generator test does not hand lower ids to the shooter test')
  // The upper-bound branch must skip the whole generator path: land just past its block (the game's next compare).
  if (target(code, ge! + GEN_BCS) !== ge! + GENERATOR.length)
    return fail('the generator test upper bound does not skip past the generator path')
  // The shooter test's call must reach the shooter loader (a repointed call would make a sprite loader look like a shooter).
  const callee = b(sh! + SH_JSR + 1) | (b(sh! + SH_JSR + 2) << 8)
  if (!matches(code, callee - 0x8000, LOAD_SHOOTER))
    return fail("the shooter test calls something other than the loader's shooter routine")
  // One proven way on to the next sprite, `ln`: the entry's two skips land there, and every other exit (generator tail, shooter
  // tail, scroll guard) must be a BRA to it. No exit may land inside a matched shape (an operand byte can look like a BRA).
  const [skip, ln] = [target(code, s!), target(code, s! + SKIP_A)]
  const spans = [[s!, s! + SCROLL.length], [eeries, eeries + LOADER_CALL.length], [platforms, platforms + LOADER_CALL.length], [ge!, ge! + GENERATOR.length], [sh!, sh! + SHOOTER.length]] // prettier-ignore
  const inside = (a: number) => spans.some(([lo, hi]) => a >= lo! && a < hi!)
  const viaBra = (a: number) => b(a) === 0x80 && target(code, a) === ln && !inside(a)
  if (b(skip) !== 0x60 || ln !== target(code, s! + SKIP_B) || inside(ln) || inside(skip))
    return fail('the sprite load start does not skip the way the loader does')
  const next = target(code, ge! + GEN_TAIL)
  if (target(code, sh! + SH_BRA) !== next || !viaBra(next))
    return fail('the generator and shooter paths do not both go on to the next sprite')
  const guard = target(code, sc + SC_GUARD)
  if (!viaBra(guard) || guard <= sc)
    return fail('the scroll command guard does not skip past its store')
  if (target(code, sh! + SH_BCC) !== sh! + SH_PAST)
    return fail('the shooter test does not hand lower ids on to the sprite slots')
  if (!(shootFrom < genFrom && genFrom < genTo))
    return fail('the loader tests are not in an order this reader knows')
  // The ids the Eeries and platform tests take are loaded by their own routines, so they must sit between the generator band
  // and the scroll bound: one inside the shooter or generator band would be a class this reader would call wrongly.
  for (const id of [b(eeries + 1), b(platforms + 1)])
    if (id < genTo || id >= scrollFrom)
      return fail(
        'the Eeries or platform test takes ids from outside the range between the generators and the scroll commands',
      )
  return {
    status: 'ok',
    of: id =>
      id >= scrollFrom ? 'scroll' : id >= genFrom && id < genTo ? 'generator' : id >= shootFrom && id < genFrom ? 'shooter' : 'normal', // prettier-ignore
  }
}
