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
 * scroll test must also follow the instruction pair that stores the sprite number (a dead or unlinked copy of the
 * shapes reads `unavailable`). The scroll compare and subtract, and the generator compare and subtract, must carry
 * one number each. Any other shape is `status: 'unavailable'`, with the reason, and the caller then treats the id
 * as an ordinary sprite.
 * Not checked: that the routine's entry is still reached. That needs the caller of the level load, which has no
 * address in the ROM that is not itself a constant, so a patch that diverts control to a copy elsewhere is not seen.
 */
import type { RomFile } from '../../RomFile'

export type LoadClass = 'normal' | 'shooter' | 'generator' | 'scroll'

export type LoadClasses =
  { status: 'ok'; of: (id: number) => LoadClass } | { status: 'unavailable'; reason: string }

const BANK2 = 0x028000
// null matches any byte (an operand or a branch displacement); the rest are opcodes.
/** The sprite number was just stored and the index backed up; then CMP, BCC, the scroll-command store. */
const SCROLL = [0x85, null, 0x88, 0xc9, null, 0x90, null, 0xad, null, null, 0x0d, null, null, 0xd0, null, 0x5a, 0xda, 0xa5, null, 0x38, 0xe9, null, 0x8d] // prettier-ignore
/** The Eeries and platforms tests: CMP, BNE past a call that saves X and Y. */
const LOADER_CALL = [0xc9, null, 0xd0, null, 0x5a, 0xda, 0x88, 0x84, null, 0x20] // prettier-ignore
const GENERATOR = [0xc9, null, 0x90, null, 0xc9, null, 0xb0, null, 0x38, 0xe9, null, 0x1a, 0x8d] // prettier-ignore
const SHOOTER = [0xc9, null, 0x90, null, 0x20, null, null, 0x80, null, 0xa9] // prettier-ignore
export const SHAPES = { scroll: SCROLL, loaderCall: LOADER_CALL, generator: GENERATOR, shooter: SHOOTER } // prettier-ignore

const fail = (reason: string): LoadClasses => ({ status: 'unavailable', reason })
const matches = (code: Uint8Array, at: number, want: (number | null)[]) =>
  at >= 0 && want.every((w, k) => w === null || code[at + k] === w)

function find(code: Uint8Array, want: (number | null)[]): number[] {
  const hits: number[] = []
  for (let i = 0; i + want.length <= code.length; i++) if (matches(code, i, want)) hits.push(i)
  return hits
}

/** Where the branch whose opcode is at `at` lands. */
const target = (code: Uint8Array, at: number) =>
  at + 2 + (code[at + 1]! < 0x80 ? code[at + 1]! : code[at + 1]! - 0x100)

const cache = new WeakMap<RomFile, LoadClasses>()

export function loadClasses(rom: RomFile): LoadClasses {
  const hit = cache.get(rom)
  if (hit) return hit
  const r = read(rom)
  cache.set(rom, r)
  return r
}

function read(rom: RomFile): LoadClasses {
  const code = rom.readAt(BANK2, 0x8000)
  if (!code) return fail('bank 2 of the ROM could not be read')
  const once = (name: string, shape: (number | null)[]): number | string => {
    const hits = find(code, shape)
    return hits.length === 1 ? hits[0]! : `the level loader's ${name} test was found ${hits.length} times, so which one runs is unknown` // prettier-ignore
  }
  const [s, g, h] = [once('scroll', SCROLL), once('generator', GENERATOR), once('shooter', SHOOTER)]
  for (const x of [s, g, h]) if (typeof x === 'string') return fail(x)
  const [sc, ge, sh] = [(s as number) + 3, g as number, h as number] // sc: the scroll CMP itself
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
  if (target(code, sh + 2) !== sh + 9)
    return fail('the shooter test does not hand lower ids on to the sprite slots')
  const shootFrom = code[sh + 1]!
  if (!(shootFrom < genFrom && genFrom < genTo && genTo <= scrollFrom))
    return fail('the loader tests are not in an order this reader knows')
  return {
    status: 'ok',
    of: id =>
      id >= scrollFrom ? 'scroll' : id >= genFrom && id < genTo ? 'generator' : id >= shootFrom && id < genFrom ? 'shooter' : 'normal', // prettier-ignore
  }
}
