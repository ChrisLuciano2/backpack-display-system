#!/usr/bin/env python3
"""Builds "Backpack Controller Test.nes", a tiny NES ROM written from scratch for this project.

What it does: the screen is one solid color. Pressing a button on controller 1 changes the
color (A green, B red, Select yellow, Start blue, Up white, Down light blue, Left violet,
Right orange) and holding A plays a tone. Controller 2 does the same with different colors
and a higher tone. Nothing pressed shows dark teal.

It exists to test picture, sound and controllers with no game files. No third party code or
art is in it, so it can be shown and shared freely (CC0).

Usage: python make_test_rom.py [output.nes]
"""
import sys

BASE = 0xC000
code = bytearray()
labels = {}
fixups = []


def here():
    return BASE + len(code)


def label(name):
    labels[name] = here()


def emit(*vals):
    code.extend(vals)


def absolute(opcode, name):
    code.append(opcode)
    fixups.append((len(code), name, "abs"))
    code.extend([0, 0])


def relative(opcode, name):
    code.append(opcode)
    fixups.append((len(code), name, "rel"))
    code.append(0)


# ── reset ───────────────────────────────────────────────────────────────────
label("reset")
emit(0x78, 0xD8)                    # SEI, CLD
emit(0xA2, 0x40, 0x8E, 0x17, 0x40)  # LDX #$40 ; STX $4017  (no APU frame IRQ)
emit(0xA2, 0xFF, 0x9A)              # LDX #$FF ; TXS
emit(0xE8)                          # INX (X = 0)
emit(0x8E, 0x00, 0x20)              # STX $2000  (NMI off)
emit(0x8E, 0x01, 0x20)              # STX $2001  (rendering off)
emit(0x8E, 0x10, 0x40)              # STX $4010  (DMC IRQ off)
label("vb1")
emit(0x2C, 0x02, 0x20)              # BIT $2002
relative(0x10, "vb1")               # BPL vb1
label("vb2")
emit(0x2C, 0x02, 0x20)
relative(0x10, "vb2")

# sound setup: both square channels, silent, endless (length halt)
emit(0xA9, 0x03, 0x8D, 0x15, 0x40)  # LDA #3 ; STA $4015
emit(0xA9, 0x30, 0x8D, 0x00, 0x40)  # LDA #$30 ; STA $4000
emit(0x8D, 0x04, 0x40)              # STA $4004
emit(0xA9, 0xFD, 0x8D, 0x02, 0x40)  # LDA #$FD ; STA $4002  (player 1 pitch)
emit(0xA9, 0x7E, 0x8D, 0x06, 0x40)  # LDA #$7E ; STA $4006  (player 2 pitch, higher)
emit(0xA9, 0x00, 0x8D, 0x03, 0x40)  # LDA #0 ; STA $4003
emit(0x8D, 0x07, 0x40)              # STA $4007
emit(0xA9, 0x1E, 0x8D, 0x01, 0x20)  # LDA #$1E ; STA $2001  (rendering on)

# ── one pass per frame ──────────────────────────────────────────────────────
label("frame")
label("vb")
emit(0x2C, 0x02, 0x20)              # BIT $2002
relative(0x10, "vb")                # BPL vb   (wait for vertical blank)
emit(0xA9, 0x01, 0x8D, 0x16, 0x40)  # LDA #1 ; STA $4016
emit(0xA9, 0x00, 0x8D, 0x16, 0x40)  # LDA #0 ; STA $4016  (latch both controllers)
emit(0xA9, 0x0C, 0x85, 0x01)        # LDA #$0C ; STA $01  (dark teal when nothing is pressed)
emit(0xA9, 0x30, 0x85, 0x02)        # LDA #$30 ; STA $02  (player 1 tone off)
emit(0x85, 0x03)                    # STA $03             (player 2 tone off)

for player, port, table, tone_var in ((1, 0x4016, "tbl1", 0x02), (2, 0x4017, "tbl2", 0x03)):
    emit(0xA2, 0x00)                                # LDX #0
    label(f"rd{player}")
    emit(0xAD, port & 0xFF, port >> 8)              # LDA $401x
    emit(0x29, 0x01)                                # AND #1
    relative(0xF0, f"n{player}")                    # BEQ next
    absolute(0xBD, table)                           # LDA table,X
    emit(0x85, 0x01)                                # STA $01  (backdrop color)
    emit(0xE0, 0x00)                                # CPX #0   (button A?)
    relative(0xD0, f"n{player}")                    # BNE next
    emit(0xA9, 0x3F, 0x85, tone_var)                # LDA #$3F ; STA tone  (tone on)
    label(f"n{player}")
    emit(0xE8, 0xE0, 0x08)                          # INX ; CPX #8
    relative(0xD0, f"rd{player}")                   # BNE read-next-button

emit(0xA5, 0x02, 0x8D, 0x00, 0x40)  # LDA $02 ; STA $4000
emit(0xA5, 0x03, 0x8D, 0x04, 0x40)  # LDA $03 ; STA $4004
emit(0xAD, 0x02, 0x20)              # LDA $2002  (reset the PPU address latch)
emit(0xA9, 0x3F, 0x8D, 0x06, 0x20)  # LDA #$3F ; STA $2006
emit(0xA9, 0x00, 0x8D, 0x06, 0x20)  # LDA #$00 ; STA $2006
emit(0xA5, 0x01, 0x8D, 0x07, 0x20)  # LDA $01 ; STA $2007  (set the backdrop color)
emit(0xA9, 0x00, 0x8D, 0x05, 0x20)  # LDA #0 ; STA $2005
emit(0x8D, 0x05, 0x20)              # STA $2005  (scroll back to 0)
absolute(0x4C, "frame")             # JMP frame

# ── color tables, order: A, B, Select, Start, Up, Down, Left, Right ─────────
label("tbl1")
emit(0x2A, 0x16, 0x28, 0x12, 0x30, 0x21, 0x24, 0x27)
label("tbl2")
emit(0x1A, 0x06, 0x38, 0x02, 0x20, 0x11, 0x14, 0x17)

# ── resolve addresses ───────────────────────────────────────────────────────
for pos, name, kind in fixups:
    target = labels[name]
    if kind == "abs":
        code[pos] = target & 0xFF
        code[pos + 1] = target >> 8
    else:
        offset = target - (BASE + pos + 1)
        assert -128 <= offset <= 127, f"branch to {name} out of range ({offset})"
        code[pos] = offset & 0xFF

# ── build the file: header, 16 KB program, 8 KB graphics ────────────────────
prg = bytearray(b"\xFF" * 16384)
prg[: len(code)] = code
reset = labels["reset"]
vectors = bytes([reset & 0xFF, reset >> 8]) * 3      # NMI, RESET, IRQ all go to reset
prg[0x3FFA:0x4000] = vectors
chr_rom = bytes(8192)
header = b"NES\x1A" + bytes([1, 1, 0, 0]) + bytes(8)

out = sys.argv[1] if len(sys.argv) > 1 else "Backpack Controller Test.nes"
with open(out, "wb") as f:
    f.write(header + prg + chr_rom)
print(f"wrote {out}: {len(code)} bytes of code, reset at ${reset:04X}")
