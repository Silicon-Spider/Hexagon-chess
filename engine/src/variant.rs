//! Variant definitions (SPEC §2.2 Gliński, §2.3 McCooey) and the pawn tables that depend
//! on them. All tables are computed at compile time.

use crate::geometry::*;

/// A supported variant. The discriminant is the ABI variant number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Variant {
    /// Gliński's hexagonal chess (variant 0, default).
    Glinski = 0,
    /// McCooey's hexagonal chess (variant 1).
    McCooey = 1,
}

/// Number of variants (`hc_variant_count`).
pub const VARIANT_COUNT: usize = 2;

/// How a stalemate is scored (`hc_variant_stalemate_rule`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum StalemateRule {
    /// ½–½.
    Draw = 0,
    /// The stalemating player scores ¾, the stalemated player ¼ (Gliński).
    ThreeQuarters = 1,
    /// The stalemating player wins.
    Win = 2,
}

/// Shade given to a cell colour class by a variant's traditional board.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Shade {
    Light = 0,
    Mid = 1,
    Dark = 2,
}

/// Static description of a variant.
#[derive(Debug)]
pub struct VariantDef {
    /// Display name (UTF-8), e.g. "Gliński".
    pub name: &'static str,
    /// FEN of the start position (SPEC §5.1).
    pub start_fen: &'static str,
    pub stalemate_rule: StalemateRule,
    /// `pawn_capture_dirs[color]`: the two directions in which a pawn of that colour captures.
    pub pawn_capture_dirs: [[usize; 2]; 2],
    /// `double_step[color]`: cells from which a pawn of that colour may double step.
    pub double_step: [Bitboard; 2],
    /// Shade of colour classes 0, 1, 2 (see [`CELL_COLOR`]).
    pub class_shade: [Shade; 3],
}

pub const GLINSKI_START_FEN: &str =
    "b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1";
pub const MCCOOEY_START_FEN: &str =
    "b/qbk/rnbnr/ppppppp/9/11/11/5P5/4PBP4/3PNBNP3/2PRQBKRP2 w - 0 1";

const fn cells_mask(names: &[&str]) -> Bitboard {
    let mut m = 0u128;
    let mut i = 0;
    while i < names.len() {
        m |= 1u128 << cell_const(names[i]);
        i += 1;
    }
    m
}

const GLINSKI_PAWN_DIRS: [[usize; 2]; 2] = [[DIR_NW, DIR_NE], [DIR_SW, DIR_SE]];
const MCCOOEY_PAWN_DIRS: [[usize; 2]; 2] = [[DIR_NNW, DIR_NNE], [DIR_SSW, DIR_SSE]];

/// All variant definitions, indexed by `Variant as usize`.
pub static VARIANTS: [VariantDef; VARIANT_COUNT] = [
    VariantDef {
        name: "Gliński",
        start_fen: GLINSKI_START_FEN,
        stalemate_rule: StalemateRule::ThreeQuarters,
        pawn_capture_dirs: GLINSKI_PAWN_DIRS,
        double_step: [
            cells_mask(&["b1", "c2", "d3", "e4", "f5", "g4", "h3", "i2", "k1"]),
            cells_mask(&["b7", "c7", "d7", "e7", "f7", "g7", "h7", "i7", "k7"]),
        ],
        class_shade: [Shade::Mid, Shade::Light, Shade::Dark],
    },
    VariantDef {
        name: "McCooey",
        start_fen: MCCOOEY_START_FEN,
        stalemate_rule: StalemateRule::Draw,
        pawn_capture_dirs: MCCOOEY_PAWN_DIRS,
        double_step: [
            cells_mask(&["c1", "d2", "e3", "g3", "h2", "i1"]),
            cells_mask(&["c8", "d8", "e8", "g8", "h8", "i8"]),
        ],
        class_shade: [Shade::Light, Shade::Mid, Shade::Dark],
    },
];

impl Variant {
    pub const ALL: [Variant; VARIANT_COUNT] = [Variant::Glinski, Variant::McCooey];

    /// Variant from its ABI number.
    #[inline]
    pub fn from_index(v: u32) -> Option<Variant> {
        match v {
            0 => Some(Variant::Glinski),
            1 => Some(Variant::McCooey),
            _ => None,
        }
    }

    #[inline]
    pub fn index(self) -> usize {
        self as usize
    }

    #[inline]
    pub fn def(self) -> &'static VariantDef {
        &VARIANTS[self as usize]
    }

    #[inline]
    pub fn name(self) -> &'static str {
        self.def().name
    }

    #[inline]
    pub fn start_fen(self) -> &'static str {
        self.def().start_fen
    }

    #[inline]
    pub fn stalemate_rule(self) -> StalemateRule {
        self.def().stalemate_rule
    }

    /// Cells a pawn of `color` standing on `cell` attacks (its two capture targets).
    #[inline(always)]
    pub fn pawn_attacks(self, color: usize, cell: usize) -> Bitboard {
        PAWN_ATTACKS[self as usize][color][cell]
    }

    /// Cells from which a pawn of `color` may double step.
    #[inline(always)]
    pub fn double_step_cells(self, color: usize) -> Bitboard {
        VARIANTS[self as usize].double_step[color]
    }
}

// ---------------------------------------------------------------------------------------
// Pawn tables

const fn build_pawn_attacks() -> [[[Bitboard; NUM_CELLS]; 2]; VARIANT_COUNT] {
    let dirs = [GLINSKI_PAWN_DIRS, MCCOOEY_PAWN_DIRS];
    let neighbors = NEIGHBOR_TABLE;
    let mut t = [[[0u128; NUM_CELLS]; 2]; VARIANT_COUNT];
    let mut v = 0;
    while v < VARIANT_COUNT {
        let mut color = 0;
        while color < 2 {
            let mut c = 0;
            while c < NUM_CELLS {
                let mut k = 0;
                while k < 2 {
                    let n = neighbors[dirs[v][color][k]][c];
                    if n != NO_CELL {
                        t[v][color][c] |= 1u128 << n;
                    }
                    k += 1;
                }
                c += 1;
            }
            color += 1;
        }
        v += 1;
    }
    t
}

const fn build_pawn_push() -> [[u8; NUM_CELLS]; 2] {
    [NEIGHBOR_TABLE[DIR_N], NEIGHBOR_TABLE[DIR_S]]
}

const fn build_promotion_cells() -> [Bitboard; 2] {
    let mut white = 0u128;
    let mut black = 0u128;
    let mut fi = 0;
    while fi < NUM_FILES {
        white |= 1u128 << (FILE_OFFSET[fi] as usize + FILE_LEN[fi] as usize - 1);
        black |= 1u128 << FILE_OFFSET[fi];
        fi += 1;
    }
    [white, black]
}

const fn build_promo_distance() -> [[u8; NUM_CELLS]; 2] {
    let mut t = [[0u8; NUM_CELLS]; 2];
    let mut fi = 0;
    while fi < NUM_FILES {
        let len = FILE_LEN[fi] as usize;
        let mut rank = 1;
        while rank <= len {
            let c = FILE_OFFSET[fi] as usize + rank - 1;
            t[0][c] = (len - rank) as u8;
            t[1][c] = (rank - 1) as u8;
            rank += 1;
        }
        fi += 1;
    }
    t
}

/// `PAWN_ATTACKS[variant][color][cell]`: capture targets of a pawn. Because Black's capture
/// directions are the negations of White's in both variants, the pawns of colour `c` that
/// attack `cell` are `PAWN_ATTACKS[v][c ^ 1][cell] & pawns(c)`.
pub static PAWN_ATTACKS: [[[Bitboard; NUM_CELLS]; 2]; VARIANT_COUNT] = build_pawn_attacks();
/// `PAWN_PUSH[color][cell]`: the cell straight ahead (White N, Black S) or [`NO_CELL`].
pub static PAWN_PUSH: [[u8; NUM_CELLS]; 2] = build_pawn_push();
/// `PROMOTION_CELLS[color]`: the last cell of every file for that colour (SPEC §2.1).
pub const PROMOTION_CELLS: [Bitboard; 2] = build_promotion_cells();
/// `PROMO_DISTANCE[color][cell]`: single pushes needed from `cell` to reach the promotion
/// cell of its file (0 on the promotion cell itself).
pub static PROMO_DISTANCE: [[u8; NUM_CELLS]; 2] = build_promo_distance();
