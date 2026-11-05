/**
 * What the game's own level load does with a sprite-list entry (#1011): most ids fill a slot and run as a
 * sprite, but the loader sends a shooter, a generator and a scroll command elsewhere, and none of those has
 * a sprite of its own to draw (SMWDisX bank_02.asm:5290-5368; the shooter dispatch is 6831-6832).
 *
 * The class bounds are read from the compare operands of that routine, never held as constants here
 * (.claude/rules/rom-interpretation.md). Each test is found by its opcode shape in bank 2 and must match
 * exactly once, and the tests must be LINKED the way the game chains them: the scroll test's below-range branch lands
 * on the Eeries test, whose not-equal branch lands on the platforms test, whose not-equal branch lands on the generator
 * test, whose below-range branch lands on the shooter test, whose below-range branch lands past its own call. The
 * scroll test must also sit behind the routine's first instructions (skip unless the entry is at the screen boundary and not
 * yet loaded, mark it loaded, store its number), so a hook patched over that start, or a dead or unlinked copy of the
 * shapes, reads `unavailable`. The scroll compare and subtract, and the generator compare and subtract, must carry one
 * number each. Any other shape is `status: 'unavailable'`, with the reason, and the caller then treats the id as an
 * ordinary sprite.
 * Every branch in the chain has its DESTINATION read, not just its opcode: the three hops above, the generator's upper-bound
 * branch (it must skip the whole generator path), and every exit toward the next sprite, which must resolve to ONE proven
 * place: the entry's two skips land on it, and the generator tail, the shooter tail and the scroll guard are each a BRA to it,
 * landing outside every matched shape (an operand byte can look like a BRA). The ids the Eeries and platform tests take must
 * lie between the generator band and the scroll bound. The two call targets (the subroutines the Eeries, platform and
 * shooter tests call) are not checked: they do not decide which class an id has.
 * Not checked: what reaches that first instruction. The loop that calls it has no ROM address that is not itself a
 * constant, so a patch that diverts control before it, to a copy elsewhere, is not seen.
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
export const SHAPES = { scroll: SCROLL, loaderCall: LOADER_CALL, generator: GENERATOR, shooter: SHOOTER } // prettier-ignore

/** An unreadable loader, with the reason. */
const fail = (reason: string): LoadClasses => ({ status: 'unavailable', reason })
/** Whether the opcode shape `want` (null matches any byte) sits at `at`. */
const matches = (code: Uint8Array, at: number, want: (number | null)[]) =>
  at >= 0 && want.every((w, k) => w === null || code[at + k] === w)

/** Every place in `code` the shape matches. */
function find(code: Uint8Array, want: (number | null)[]): number[] {
  const hits: number[] = []
  for (let i = 0; i + want.length <= code.length; i++) if (matches(code, i, want)) hits.push(i)
  return hits
}

/** Where the branch whose opcode is at `at` lands. */
const target = (code: Uint8Array, at: number) =>
  at + 2 + (code[at + 1]! < 0x80 ? code[at + 1]! : code[at + 1]! - 0x100)

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
  /** The one place a shape matches, or the reason it does not match exactly once. */
  const once = (name: string, shape: (number | null)[]): number | string => {
    const hits = find(code, shape)
    return hits.length === 1 ? hits[0]! : `the level loader's ${name} test was found ${hits.length} times, so which one runs is unknown` // prettier-ignore
  }
  const [s, g, h] = [once('scroll', SCROLL), once('generator', GENERATOR), once('shooter', SHOOTER)]
  for (const x of [s, g, h]) if (typeof x === 'string') return fail(x)
  const [sc, ge, sh] = [(s as number) + ENTRY.length, g as number, h as number] // sc: the scroll CMP itself
  const scrollFrom = code[sc + 1]!
  if (code[sc + 18] !== scrollFrom)
    return fail('the scroll test and the command number it subtracts differ')
  const [genFrom, genTo] = [code[ge + 1]!, code[ge + 5]!]
  if (code[ge + 10] !== genFrom)
    return fail('the generator test and the number it subtracts differ')
  // The chain the game walks, each hop by the branch's own displacement.
  const eeries = target(code, sc + 2)
  const platforms = target(code, eeries + 2)
  if (
    !matches(code, eeries, LOADER_CALL) ||
    !matches(code, platforms, LOADER_CALL) ||
    target(code, platforms + 2) !== ge
  )
    return fail(
      'the scroll test does not lead through the Eeries and platform tests to the generator test',
    )
  if (target(code, ge + 2) !== sh)
    return fail('the generator test does not hand lower ids to the shooter test')
  // The upper-bound branch must skip the whole generator path: land just past its block (the game's next compare).
  const past = ge + GENERATOR.length
  if (target(code, ge + 6) !== past)
    return fail('the generator test upper bound does not skip past the generator path')
  // One proven way on to the next sprite, `ln`: the entry's two skips land there, and every other exit (generator tail, shooter
  // tail, scroll guard) must be a BRA to it. No exit may land inside a matched shape (an operand byte can look like a BRA).
  const [skip, ln] = [target(code, s as number), target(code, (s as number) + 8)]
  const spans = [[s as number, (s as number) + SCROLL.length], [eeries, eeries + LOADER_CALL.length], [platforms, platforms + LOADER_CALL.length], [ge, ge + GENERATOR.length], [sh, sh + SHOOTER.length]] // prettier-ignore
  const inside = (a: number) => spans.some(([lo, hi]) => a > lo! && a < hi!)
  const viaBra = (a: number) => code[a] === 0x80 && target(code, a) === ln && !inside(a)
  if (code[skip] !== 0x60 || ln !== target(code, (s as number) + 13) || inside(ln) || inside(skip))
    return fail('the sprite load start does not skip the way the loader does')
  const next = target(code, ge + 18)
  if (target(code, sh + 7) !== next || !viaBra(next))
    return fail('the generator and shooter paths do not both go on to the next sprite')
  const guard = target(code, sc + 10)
  if (!viaBra(guard) || guard <= sc)
    return fail('the scroll command guard does not skip past its store')
  if (target(code, sh + 2) !== sh + 9)
    return fail('the shooter test does not hand lower ids on to the sprite slots')
  const shootFrom = code[sh + 1]!
  if (!(shootFrom < genFrom && genFrom < genTo))
    return fail('the loader tests are not in an order this reader knows')
  // The ids the Eeries and platform tests take are loaded by their own routines, so they must sit between the generator band
  // and the scroll bound: one inside the shooter or generator band would be a class this reader would call wrongly.
  for (const id of [code[eeries + 1]!, code[platforms + 1]!])
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
