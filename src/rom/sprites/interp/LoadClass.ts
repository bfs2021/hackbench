/**
 * What the game's own level load does with a sprite-list entry (#1011): most ids fill a slot and run as a
 * sprite, but the loader sends a shooter, a generator and a scroll command elsewhere, and none of those has
 * a sprite of its own to draw (SMWDisX bank_02.asm:5290-5368; the shooter dispatch is 6831-6832).
 *
 * The class bounds are read from the compare operands of that routine, never held as constants here
 * (.claude/rules/rom-interpretation.md): each test is found by its opcode shape in bank 2, must match exactly
 * once, and must agree with its neighbours (the scroll compare and subtract carry the same bound, the
 * generator's low branch lands on the shooter test). Any other shape is `status: 'unavailable'`, with the reason, and the
 * caller then treats the id as an ordinary sprite.
 */
import type { RomFile } from '../../RomFile'

export type LoadClass = 'normal' | 'shooter' | 'generator' | 'scroll'

export type LoadClasses =
  { status: 'ok'; of: (id: number) => LoadClass } | { status: 'unavailable'; reason: string }

const BANK2 = 0x028000
// null matches any byte (an operand or a branch displacement); the rest are opcodes.
const SCROLL = [0xc9, null, 0x90, null, 0xad, null, null, 0x0d, null, null, 0xd0, null, 0x5a, 0xda, 0xa5, null, 0x38, 0xe9, null, 0x8d] // prettier-ignore
const GENERATOR = [0xc9, null, 0x90, null, 0xc9, null, 0xb0, null, 0x38, 0xe9, null, 0x1a, 0x8d] // prettier-ignore
const SHOOTER = [0xc9, null, 0x90, null, 0x20, null, null, 0x80, null, 0xa9] // prettier-ignore

function find(code: Uint8Array, want: (number | null)[]): number[] {
  const hits: number[] = []
  for (let i = 0; i + want.length <= code.length; i++)
    if (want.every((w, k) => w === null || code[i + k] === w)) hits.push(i)
  return hits
}

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
  if (!code) return { status: 'unavailable', reason: 'bank 2 of the ROM could not be read' }
  const at = (name: string, shape: (number | null)[]): number | string => {
    const hits = find(code, shape)
    return hits.length === 1 ? hits[0]! : `the level loader's ${name} test was found ${hits.length} times, so which one runs is unknown` // prettier-ignore
  }
  const [s, g, h] = [at('scroll', SCROLL), at('generator', GENERATOR), at('shooter', SHOOTER)]
  for (const x of [s, g, h]) if (typeof x === 'string') return { status: 'unavailable', reason: x }
  const [sc, ge, sh] = [s as number, g as number, h as number]
  const scrollFrom = code[sc + 1]!
  if (code[sc + 18] !== scrollFrom) return { status: 'unavailable', reason: 'the scroll test and the command number it subtracts differ' } // prettier-ignore
  const [genFrom, genTo] = [code[ge + 1]!, code[ge + 5]!]
  if (code[ge + 10] !== genFrom) return { status: 'unavailable', reason: 'the generator test and the number it subtracts differ' } // prettier-ignore
  // The generator's "below range" branch must land on the shooter test, or the shooters are not routed as read.
  const rel = code[ge + 3]! < 0x80 ? code[ge + 3]! : code[ge + 3]! - 0x100
  if (ge + 4 + rel !== sh) return { status: 'unavailable', reason: 'the generator test does not hand lower ids to the shooter test' } // prettier-ignore
  const shootFrom = code[sh + 1]!
  if (!(shootFrom < genFrom && genFrom < genTo && genTo <= scrollFrom))
    return {
      status: 'unavailable',
      reason: 'the loader tests are not in an order this reader knows',
    }
  return {
    status: 'ok',
    of: id =>
      id >= scrollFrom ? 'scroll' : id >= genFrom && id < genTo ? 'generator' : id >= shootFrom && id < genFrom ? 'shooter' : 'normal', // prettier-ignore
  }
}
