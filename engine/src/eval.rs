//! Static evaluation (SPEC §10).
//!
//! * [`evaluate`] — centipawns from WHITE's point of view (what `hc_eval` reports).
//! * [`evaluate_stm`] — the search's view: from the side to move's point of view, plus the
//!   small tempo bonus [`TEMPO`]. The tempo term is deliberately kept out of [`evaluate`] so
//!   that the colour-symmetric start positions read exactly 0 and an evaluation readout fed by
//!   `hc_eval` does not flicker by ±TEMPO from one ply to the next.
//!
//! Every term is computed for both colours with the same code (White minus Black), and all
//! geometric inputs (hex distance to f6, pushes left to promotion, pawn capture cells) are
//! symmetric under the board's horizontal mirror, so the evaluation is exactly antisymmetric:
//! mirroring a position and swapping the colours negates the score (tested).
//!
//! Middlegame (`mg`) and endgame (`eg`) values are blended by the game phase, measured by the
//! non-pawn material on the board (N = B = 1, R = 2, Q = 4, capped at [`PHASE_MAX`] = 24; both
//! start positions have 26, i.e. full middlegame).
//!
//! Terms:
//! * **material** P 100, N 300, B 300, R 500, Q 900 — the SPEC values, unchanged (the knight's
//!   12 jumps and the bishop's colour binding to a third of the board are left to the
//!   mobility and centralisation terms rather than baked into the piece values);
//! * **centralisation** by hex distance to f6 for N, B, Q (and for the king in the endgame);
//! * **mobility** (light): cells a piece attacks that are neither own-occupied nor attacked by
//!   enemy pawns, centred on a typical count so that it does not inflate piece values;
//! * **pawns**: advancement by pushes left to promotion (grows sharply near the last cell), a
//!   small centre bonus, doubled / isolated penalties;
//! * **passed pawns**: a pawn is passed when no enemy pawn stands on its path, on a cell from
//!   which it could capture the pawn on (or ahead of) its current cell, or anywhere "behind"
//!   such a cell on that cell's file (enemy pawns can only come towards the pawn). The capture
//!   geometry is the variant's own (Gliński: orthogonal 60° captures; McCooey: diagonal
//!   captures), see [`PASSED_MASK`]. Bonus by advancement (halved when blocked), plus king
//!   proximity in the endgame;
//! * **king**: middlegame penalty for leaving the home edge, pawn shelter on the 12 neighbouring
//!   cells, and an attack penalty that grows with the number and weight of enemy pieces
//!   hitting the king zone; endgame centralisation;
//! * **endgame knowledge**: a side without pawns that is at most a minor piece ahead gets its
//!   advantage scaled down (a lone minor cannot mate), and against a bare king the stronger
//!   side is rewarded for driving it to the edge and approaching with its own king (mop-up).

use crate::geometry::*;
use crate::position::*;
use crate::variant::*;

/// Material values in centipawns, indexed by piece kind (SPEC §10). The king has no value.
pub const PIECE_VALUE: [i32; 7] = [0, 100, 300, 300, 500, 900, 0];

/// Bonus for the side to move, added by [`evaluate_stm`] only (see the module docs).
pub const TEMPO: i32 = 10;

/// Phase weight of each piece kind (pawns and kings do not count).
const PHASE_INC: [i32; 7] = [0, 0, 1, 1, 2, 4, 0];
/// Phase of a full middlegame (the phase is capped here; both start positions have 26).
pub const PHASE_MAX: i32 = 24;

// Centralisation by hex distance to f6 (index 0 = f6 … 5 = the board's edge), as (mg, eg).
const KNIGHT_CENTER: [(i32, i32); 6] = [(18, 12), (14, 10), (8, 5), (0, 0), (-10, -8), (-24, -18)];
const BISHOP_CENTER: [(i32, i32); 6] = [(10, 8), (8, 6), (5, 4), (0, 0), (-5, -4), (-12, -10)];
const QUEEN_CENTER: [(i32, i32); 6] = [(4, 12), (4, 10), (2, 6), (0, 0), (-2, -6), (-6, -14)];
const KING_CENTER_EG: [i32; 6] = [30, 24, 14, 0, -16, -32];
const PAWN_CENTER_MG: [i32; 6] = [12, 9, 4, 0, 0, 0];

/// Middlegame king placement by distance from its own home edge, counted in cells along its
/// file (0 = rank 1 for White / the top cell of the file for Black).
const KING_HOME_MG: [i32; 11] = [0, -12, -28, -45, -62, -76, -86, -92, -96, -100, -100];

// Pawn terms indexed by pushes left to promotion (1..=10), as (mg, eg). Gliński pawns start
// 6 pushes from promotion, McCooey pawns 7.
const PAWN_ADVANCE: [(i32, i32); 11] =
    [(0, 0), (45, 95), (28, 62), (16, 38), (8, 20), (3, 9), (0, 3), (0, 0), (0, 0), (0, 0), (0, 0)];
const PASSED_BONUS: [(i32, i32); 11] = [
    (0, 0),
    (60, 165),
    (42, 118),
    (28, 80),
    (17, 52),
    (10, 32),
    (6, 18),
    (4, 10),
    (2, 5),
    (0, 2),
    (0, 0),
];
const DOUBLED: (i32, i32) = (-12, -18);
const ISOLATED: (i32, i32) = (-10, -14);

/// Mobility per safe cell (mg, eg) and the "typical" count subtracted first.
const MOBILITY: [(i32, i32, i32); 7] = [(0, 0, 0), (0, 0, 0), (4, 4, 6), (4, 4, 6), (2, 4, 10), (1, 2, 16), (0, 0, 0)];

/// King-zone attack weight per attacked zone cell, by attacking piece kind.
const KING_ATTACK_WEIGHT: [i32; 7] = [0, 0, 12, 12, 20, 36, 0];
/// Percentage of the attack weight that counts, by number of attacking pieces.
const KING_ATTACK_SCALE: [i32; 8] = [0, 0, 50, 75, 88, 94, 97, 99];
const SHELTER_PAWN: i32 = 12;

// ---------------------------------------------------------------------------------------
// Precomputed masks (compile time)

const fn build_passed_mask() -> [[[Bitboard; NUM_CELLS]; 2]; VARIANT_COUNT] {
    let mut t = [[[0u128; NUM_CELLS]; 2]; VARIANT_COUNT];
    let mut v = 0;
    while v < VARIANT_COUNT {
        let mut color = 0;
        while color < 2 {
            // Enemy pawns move against `fwd`, so the cells from which one can reach a cell `y`
            // are the cells beyond `y` in direction `fwd` (on y's file).
            let fwd = if color == WHITE { DIR_N } else { DIR_S };
            let mut sq = 0;
            while sq < NUM_CELLS {
                let mut mask = 0u128;
                let mut x = sq;
                loop {
                    // Enemy pawns attacking x stand on PAWN_ATTACKS[v][color][x] (the capture
                    // directions of the two colours are negations of each other).
                    let mut att = PAWN_ATTACKS[v][color][x];
                    while att != 0 {
                        let y = att.trailing_zeros() as usize;
                        att &= att - 1;
                        mask |= (1u128 << y) | RAYS[fwd][y];
                    }
                    let nx = NEIGHBOR[fwd][x];
                    if nx == NO_CELL {
                        break;
                    }
                    x = nx as usize;
                    mask |= 1u128 << x;
                }
                t[v][color][sq] = mask;
                sq += 1;
            }
            color += 1;
        }
        v += 1;
    }
    t
}

/// `PASSED_MASK[variant][color][cell]`: a pawn of `color` on `cell` is passed iff no enemy
/// pawn stands on this mask (its path, the cells from which enemy pawns could capture it on
/// its path, and everything behind those cells from the enemy pawns' point of view).
pub static PASSED_MASK: [[[Bitboard; NUM_CELLS]; 2]; VARIANT_COUNT] = build_passed_mask();

const fn build_file_masks() -> [Bitboard; NUM_FILES] {
    let mut t = [0u128; NUM_FILES];
    let mut f = 0;
    while f < NUM_FILES {
        let mut r = 0;
        while r < FILE_LEN[f] as usize {
            t[f] |= 1u128 << (FILE_OFFSET[f] as usize + r);
            r += 1;
        }
        f += 1;
    }
    t
}

/// All cells of each file.
pub const FILE_MASK: [Bitboard; NUM_FILES] = build_file_masks();

const fn build_adjacent_files() -> [Bitboard; NUM_FILES] {
    let m = build_file_masks();
    let mut t = [0u128; NUM_FILES];
    let mut f = 0;
    while f < NUM_FILES {
        if f > 0 {
            t[f] |= m[f - 1];
        }
        if f + 1 < NUM_FILES {
            t[f] |= m[f + 1];
        }
        f += 1;
    }
    t
}

const ADJACENT_FILES: [Bitboard; NUM_FILES] = build_adjacent_files();

// ---------------------------------------------------------------------------------------

/// The passed pawns of `color` (see [`PASSED_MASK`]).
pub fn passed_pawns(pos: &Position, color: usize) -> Bitboard {
    let v = pos.variant() as usize;
    let enemy = pos.pieces(color ^ 1, PAWN);
    let mut out = 0;
    let mut b = pos.pieces(color, PAWN);
    while b != 0 {
        let sq = pop_lsb(&mut b);
        if PASSED_MASK[v][color][sq] & enemy == 0 {
            out |= bit(sq);
        }
    }
    out
}

/// Game phase: N = B = 1, R = 2, Q = 4 summed over both colours, capped at [`PHASE_MAX`]
/// (24 = middlegame, 0 = pawn/king endgame).
pub fn phase(pos: &Position) -> i32 {
    let mut p = 0;
    for kind in KNIGHT..=QUEEN {
        p += PHASE_INC[kind] * pos.kind_bb(kind).count_ones() as i32;
    }
    p.min(PHASE_MAX)
}

/// Static evaluation in centipawns from WHITE's point of view (no tempo term).
pub fn evaluate(pos: &Position) -> i32 {
    let v = pos.variant() as usize;
    let occ = pos.occupied();
    let pawns = [pos.pieces(WHITE, PAWN), pos.pieces(BLACK, PAWN)];
    let mut pawn_att: [Bitboard; 2] = [0; 2];
    for c in 0..2 {
        let mut b = pawns[c];
        while b != 0 {
            pawn_att[c] |= PAWN_ATTACKS[v][c][pop_lsb(&mut b)];
        }
    }
    let kings = [pos.king_cell(WHITE), pos.king_cell(BLACK)];
    let zones = [
        kings[0].map_or(0, |k| KING_ATTACKS[k] | bit(k)),
        kings[1].map_or(0, |k| KING_ATTACKS[k] | bit(k)),
    ];

    let mut mg = [0i32; 2];
    let mut eg = [0i32; 2];
    let mut npm = [0i32; 2];
    let mut phase = 0;
    // King-zone attacks by colour c on the enemy king: number of pieces and total weight.
    let mut att_count = [0usize; 2];
    let mut att_weight = [0i32; 2];

    for c in 0..2 {
        let them = c ^ 1;
        let own = pos.color_bb(c);
        let mobility_area = ALL_CELLS & !own & !pawn_att[them];
        let enemy_zone = zones[them];

        for kind in KNIGHT..=QUEEN {
            let mut b = pos.pieces(c, kind);
            while b != 0 {
                let sq = pop_lsb(&mut b);
                let d = CENTER_DIST[sq] as usize;
                let (cm, ce, att) = match kind {
                    KNIGHT => (KNIGHT_CENTER[d].0, KNIGHT_CENTER[d].1, KNIGHT_ATTACKS[sq]),
                    BISHOP => (BISHOP_CENTER[d].0, BISHOP_CENTER[d].1, bishop_attacks(sq, occ)),
                    ROOK => (0, 0, rook_attacks(sq, occ)),
                    _ => (QUEEN_CENTER[d].0, QUEEN_CENTER[d].1, queen_attacks(sq, occ)),
                };
                let (wm, we, typical) = MOBILITY[kind];
                let mob = (att & mobility_area).count_ones() as i32 - typical;
                mg[c] += PIECE_VALUE[kind] + cm + wm * mob;
                eg[c] += PIECE_VALUE[kind] + ce + we * mob;
                npm[c] += PIECE_VALUE[kind];
                phase += PHASE_INC[kind];
                let z = att & enemy_zone;
                if z != 0 {
                    att_count[c] += 1;
                    att_weight[c] += KING_ATTACK_WEIGHT[kind] * z.count_ones() as i32;
                }
            }
        }

        // Pawns.
        let mut b = pawns[c];
        while b != 0 {
            let sq = pop_lsb(&mut b);
            let a = (PROMO_DISTANCE[c][sq] as usize).min(10);
            mg[c] += PIECE_VALUE[PAWN] + PAWN_ADVANCE[a].0 + PAWN_CENTER_MG[CENTER_DIST[sq] as usize];
            eg[c] += PIECE_VALUE[PAWN] + PAWN_ADVANCE[a].1;
            if PASSED_MASK[v][c][sq] & pawns[them] == 0 {
                let (mut pm, mut pe) = PASSED_BONUS[a];
                let front = PAWN_PUSH[c][sq];
                if front != NO_CELL {
                    let front = front as usize;
                    if occ & bit(front) != 0 {
                        pm /= 2;
                        pe /= 2;
                    }
                    if a <= 4 {
                        if let (Some(ok), Some(ek)) = (kings[c], kings[them]) {
                            pe += 4 * hex_distance(ek, front) as i32 - 2 * hex_distance(ok, front) as i32;
                        }
                    }
                }
                mg[c] += pm;
                eg[c] += pe;
            }
            if pawns[c] & ADJACENT_FILES[CELL_FILE[sq] as usize] == 0 {
                mg[c] += ISOLATED.0;
                eg[c] += ISOLATED.1;
            }
        }
        if pawns[c] != 0 {
            for fm in FILE_MASK.iter() {
                let n = (pawns[c] & fm).count_ones() as i32;
                if n > 1 {
                    mg[c] += DOUBLED.0 * (n - 1);
                    eg[c] += DOUBLED.1 * (n - 1);
                }
            }
        }

        // King placement and shelter.
        if let Some(k) = kings[c] {
            let home = (PROMO_DISTANCE[them][k] as usize).min(10);
            mg[c] += KING_HOME_MG[home];
            eg[c] += KING_CENTER_EG[CENTER_DIST[k] as usize];
            let shelter = (pawns[c] & KING_ATTACKS[k]).count_ones().min(3) as i32;
            mg[c] += SHELTER_PAWN * shelter;
        }
    }

    // King danger: colour c's attackers on the other king.
    for c in 0..2 {
        let n = att_count[c].min(7);
        mg[c ^ 1] -= att_weight[c] * KING_ATTACK_SCALE[n] / 100;
    }

    let phase = phase.min(PHASE_MAX);
    let mg_score = mg[WHITE] - mg[BLACK];
    let eg_score = eg[WHITE] - eg[BLACK];
    let mut score = (mg_score * phase + eg_score * (PHASE_MAX - phase)) / PHASE_MAX;

    // Drawish material: the side ahead has no pawns and at most a minor piece more.
    let scale = |strong: usize, s: i32| -> i32 {
        if pawns[strong] != 0 {
            return s;
        }
        if npm[strong] <= PIECE_VALUE[BISHOP] {
            s / 16
        } else if npm[strong] - npm[strong ^ 1] <= PIECE_VALUE[BISHOP] {
            s / 4
        } else {
            s
        }
    };
    if score > 0 {
        score = scale(WHITE, score);
    } else if score < 0 {
        score = -scale(BLACK, -score);
    }

    // Mop-up against a bare king.
    for strong in 0..2 {
        let weak = strong ^ 1;
        if pawns[weak] == 0 && npm[weak] == 0 && npm[strong] >= PIECE_VALUE[ROOK] {
            if let (Some(ks), Some(kw)) = (kings[strong], kings[weak]) {
                let bonus = 20 * CENTER_DIST[kw] as i32 + 6 * (10 - hex_distance(ks, kw) as i32);
                score += if strong == WHITE { bonus } else { -bonus };
            }
        }
    }
    score
}

/// Evaluation from the side to move's point of view, including the tempo bonus (the search's
/// static evaluation).
#[inline]
pub fn evaluate_stm(pos: &Position) -> i32 {
    let e = evaluate(pos);
    (if pos.side_to_move() == WHITE { e } else { -e }) + TEMPO
}
