//! Board geometry of the 91-cell hexagonal board (SPEC §1): cell indices, axial
//! coordinates, the 12 line directions, knight jumps and precomputed attack tables.
//!
//! * A cell is a `usize` index `0..=90` in canonical order (files `a b c d e f g h i k l`,
//!   then rank ascending): `index = FILE_OFFSET[file] + rank - 1`. Tables store cells as
//!   `u8`, with [`NO_CELL`] (= 255) meaning "off the board".
//! * Axial coordinates `(q, r)`, cube `s = -q - r`, valid iff `max(|q|,|r|,|s|) <= 5`;
//!   `q = file - 5`, `r = 6 - rank - max(q, 0)`.
//! * A [`Bitboard`] is a `u128` whose bit `i` is cell `i`; bits 91..=127 are always 0.
//! * Every table is computed at compile time by `const fn`s: no runtime initialisation.
//!
//! **Index monotonicity.** Along each of the 12 line directions the cell index is strictly
//! monotonic: it increases for the [`DIR_POSITIVE`] directions (N, NE, SE, NNE, E, SSE) and
//! decreases for their opposites (moving to a higher file always increases the index because
//! files are contiguous index blocks; within a file the index grows with the rank). Hence the
//! nearest piece on a ray is the ray's lowest set bit for positive directions and its highest
//! set bit otherwise; [`ray_attacks`] relies on this (classical ray attacks, one bit scan per
//! direction).

/// Set of cells, bit `i` = cell `i`.
pub type Bitboard = u128;

pub const NUM_CELLS: usize = 91;
/// "No cell" marker used in `u8` cell tables.
pub const NO_CELL: u8 = 0xFF;
/// "Not aligned" marker in [`DIR_BETWEEN`].
pub const NO_DIR: u8 = 0xFF;
/// All 91 cells.
pub const ALL_CELLS: Bitboard = (1u128 << NUM_CELLS) - 1;
/// f6, the centre cell.
pub const CENTER_CELL: usize = 45;

pub const NUM_FILES: usize = 11;
/// File letters left→right from White's view (there is no `j`).
pub const FILE_LETTERS: [u8; NUM_FILES] = *b"abcdefghikl";
/// Index of rank 1 of each file.
pub const FILE_OFFSET: [u8; NUM_FILES] = [0, 6, 13, 21, 30, 40, 51, 61, 70, 78, 85];
/// Number of cells (ranks) in each file.
pub const FILE_LEN: [u8; NUM_FILES] = [6, 7, 8, 9, 10, 11, 10, 9, 8, 7, 6];

// ---------------------------------------------------------------------------------------
// Directions (SPEC §1.1). 0..6 orthogonal (rook lines, clockwise from N), 6..12 diagonal
// (bishop lines, clockwise from NNE). "North" = towards Black = up the file.

pub const DIR_N: usize = 0;
pub const DIR_NE: usize = 1;
pub const DIR_SE: usize = 2;
pub const DIR_S: usize = 3;
pub const DIR_SW: usize = 4;
pub const DIR_NW: usize = 5;
pub const DIR_NNE: usize = 6;
pub const DIR_E: usize = 7;
pub const DIR_SSE: usize = 8;
pub const DIR_SSW: usize = 9;
pub const DIR_W: usize = 10;
pub const DIR_NNW: usize = 11;
pub const NUM_DIRS: usize = 12;

/// Axial delta `(dq, dr)` of each direction.
pub const DIR_DELTA: [(i32, i32); NUM_DIRS] = [
    (0, -1),  // N
    (1, -1),  // NE
    (1, 0),   // SE
    (0, 1),   // S
    (-1, 1),  // SW
    (-1, 0),  // NW
    (1, -2),  // NNE
    (2, -1),  // E
    (1, 1),   // SSE
    (-1, 2),  // SSW
    (-2, 1),  // W
    (-1, -1), // NNW
];

pub const DIR_NAME: [&str; NUM_DIRS] =
    ["N", "NE", "SE", "S", "SW", "NW", "NNE", "E", "SSE", "SSW", "W", "NNW"];

/// True if moving in this direction increases the cell index (see module docs).
pub const DIR_POSITIVE: [bool; NUM_DIRS] =
    [true, true, true, false, false, false, true, true, true, false, false, false];

pub const ORTHOGONAL_DIRS: [usize; 6] = [DIR_N, DIR_NE, DIR_SE, DIR_S, DIR_SW, DIR_NW];
pub const DIAGONAL_DIRS: [usize; 6] = [DIR_NNE, DIR_E, DIR_SSE, DIR_SSW, DIR_W, DIR_NNW];

/// The 12 knight jumps (SPEC §1.1).
pub const KNIGHT_DELTA: [(i32, i32); 12] = [
    (3, -1),
    (3, -2),
    (-1, 3),
    (-1, -2),
    (-2, 3),
    (-2, -1),
    (-3, 1),
    (-3, 2),
    (1, -3),
    (1, 2),
    (2, -3),
    (2, 1),
];

/// Opposite direction (N↔S, NE↔SW, …, NNE↔SSW, E↔W, SSE↔NNW).
#[inline]
pub const fn opposite_dir(d: usize) -> usize {
    if d < 6 {
        (d + 3) % 6
    } else {
        6 + (d - 6 + 3) % 6
    }
}

/// True for the 6 orthogonal (rook) directions.
#[inline]
pub const fn is_orthogonal(d: usize) -> bool {
    d < 6
}

// ---------------------------------------------------------------------------------------
// Coordinates

const fn iabs(x: i32) -> i32 {
    if x < 0 {
        -x
    } else {
        x
    }
}

const fn imax(a: i32, b: i32) -> i32 {
    if a > b {
        a
    } else {
        b
    }
}

/// True if axial `(q, r)` is one of the 91 cells.
#[inline]
pub const fn on_board(q: i32, r: i32) -> bool {
    iabs(q) <= 5 && iabs(r) <= 5 && iabs(q + r) <= 5
}

/// Cell index of axial `(q, r)`, or `None` if off the board.
#[inline]
pub const fn cell_at(q: i32, r: i32) -> Option<usize> {
    if !on_board(q, r) {
        return None;
    }
    let fi = (q + 5) as usize;
    let rank = 6 - r - imax(q, 0);
    Some(FILE_OFFSET[fi] as usize + rank as usize - 1)
}

const fn cell_at_u8(q: i32, r: i32) -> u8 {
    match cell_at(q, r) {
        Some(c) => c as u8,
        None => NO_CELL,
    }
}

/// Cell index of (file index 0..=10, rank 1..), or `None` if that cell does not exist.
#[inline]
pub const fn cell_from_file_rank(file: usize, rank: usize) -> Option<usize> {
    if file >= NUM_FILES || rank < 1 || rank > FILE_LEN[file] as usize {
        return None;
    }
    Some(FILE_OFFSET[file] as usize + rank - 1)
}

/// File index (0..=10) of a lowercase file letter (`a..=l`, no `j`).
#[inline]
pub const fn file_index(letter: u8) -> Option<usize> {
    let mut i = 0;
    while i < NUM_FILES {
        if FILE_LETTERS[i] == letter {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Compile-time cell lookup by name, e.g. `cell_const("f6") == 45`.
/// Panics (at compile time when used in a const context) on an invalid name.
pub const fn cell_const(name: &str) -> usize {
    let b = name.as_bytes();
    assert!(b.len() >= 2 && b.len() <= 3, "bad cell name");
    let fi = match file_index(b[0]) {
        Some(f) => f,
        None => panic!("bad file letter"),
    };
    let mut rank = 0usize;
    let mut i = 1;
    while i < b.len() {
        assert!(b[i] >= b'0' && b[i] <= b'9', "bad rank");
        rank = rank * 10 + (b[i] - b'0') as usize;
        i += 1;
    }
    match cell_from_file_rank(fi, rank) {
        Some(c) => c,
        None => panic!("no such cell"),
    }
}

struct CellInfo {
    q: [i8; NUM_CELLS],
    r: [i8; NUM_CELLS],
    file: [u8; NUM_CELLS],
    rank: [u8; NUM_CELLS],
}

const fn build_cell_info() -> CellInfo {
    let mut info = CellInfo {
        q: [0; NUM_CELLS],
        r: [0; NUM_CELLS],
        file: [0; NUM_CELLS],
        rank: [0; NUM_CELLS],
    };
    let mut fi = 0;
    while fi < NUM_FILES {
        let mut rank = 1;
        while rank <= FILE_LEN[fi] as usize {
            let idx = FILE_OFFSET[fi] as usize + rank - 1;
            let q = fi as i32 - 5;
            let r = 6 - rank as i32 - imax(q, 0);
            info.q[idx] = q as i8;
            info.r[idx] = r as i8;
            info.file[idx] = fi as u8;
            info.rank[idx] = rank as u8;
            rank += 1;
        }
        fi += 1;
    }
    info
}

const CELL_INFO: CellInfo = build_cell_info();

/// Axial q of each cell (−5..=5).
pub static CELL_Q: [i8; NUM_CELLS] = CELL_INFO.q;
/// Axial r of each cell (−5..=5).
pub static CELL_R: [i8; NUM_CELLS] = CELL_INFO.r;
/// File index (0..=10, `a`..`l`) of each cell.
pub static CELL_FILE: [u8; NUM_CELLS] = CELL_INFO.file;
/// Rank (1..=11) of each cell.
pub static CELL_RANK: [u8; NUM_CELLS] = CELL_INFO.rank;

/// Axial `(q, r)` of a cell.
#[inline]
pub fn cell_qr(c: usize) -> (i32, i32) {
    (CELL_Q[c] as i32, CELL_R[c] as i32)
}

/// Hex distance between two cells (number of orthogonal king steps).
#[inline]
pub fn hex_distance(a: usize, b: usize) -> u32 {
    let dq = CELL_Q[a] as i32 - CELL_Q[b] as i32;
    let dr = CELL_R[a] as i32 - CELL_R[b] as i32;
    ((dq.abs() + dr.abs() + (dq + dr).abs()) / 2) as u32
}

// ---------------------------------------------------------------------------------------
// Precomputed tables

const fn build_neighbors() -> [[u8; NUM_CELLS]; NUM_DIRS] {
    let mut t = [[NO_CELL; NUM_CELLS]; NUM_DIRS];
    let mut d = 0;
    while d < NUM_DIRS {
        let mut c = 0;
        while c < NUM_CELLS {
            let q = CELL_INFO.q[c] as i32 + DIR_DELTA[d].0;
            let r = CELL_INFO.r[c] as i32 + DIR_DELTA[d].1;
            t[d][c] = cell_at_u8(q, r);
            c += 1;
        }
        d += 1;
    }
    t
}

const fn build_rays() -> [[Bitboard; NUM_CELLS]; NUM_DIRS] {
    let mut t = [[0u128; NUM_CELLS]; NUM_DIRS];
    let mut d = 0;
    while d < NUM_DIRS {
        let mut c = 0;
        while c < NUM_CELLS {
            let mut q = CELL_INFO.q[c] as i32;
            let mut r = CELL_INFO.r[c] as i32;
            let mut bb = 0u128;
            loop {
                q += DIR_DELTA[d].0;
                r += DIR_DELTA[d].1;
                match cell_at(q, r) {
                    Some(x) => bb |= 1u128 << x,
                    None => break,
                }
            }
            t[d][c] = bb;
            c += 1;
        }
        d += 1;
    }
    t
}

const fn build_knight() -> [Bitboard; NUM_CELLS] {
    let mut t = [0u128; NUM_CELLS];
    let mut c = 0;
    while c < NUM_CELLS {
        let mut k = 0;
        while k < 12 {
            let q = CELL_INFO.q[c] as i32 + KNIGHT_DELTA[k].0;
            let r = CELL_INFO.r[c] as i32 + KNIGHT_DELTA[k].1;
            if let Some(x) = cell_at(q, r) {
                t[c] |= 1u128 << x;
            }
            k += 1;
        }
        c += 1;
    }
    t
}

const fn build_king() -> [Bitboard; NUM_CELLS] {
    let mut t = [0u128; NUM_CELLS];
    let mut c = 0;
    while c < NUM_CELLS {
        let mut d = 0;
        while d < NUM_DIRS {
            let n = NEIGHBOR_TABLE[d][c];
            if n != NO_CELL {
                t[c] |= 1u128 << n;
            }
            d += 1;
        }
        c += 1;
    }
    t
}

const fn build_lines(first: usize) -> [Bitboard; NUM_CELLS] {
    let mut t = [0u128; NUM_CELLS];
    let mut c = 0;
    while c < NUM_CELLS {
        let mut d = first;
        while d < first + 6 {
            t[c] |= RAY_TABLE[d][c];
            d += 1;
        }
        c += 1;
    }
    t
}

const fn build_dir_between() -> [[u8; NUM_CELLS]; NUM_CELLS] {
    let mut t = [[NO_DIR; NUM_CELLS]; NUM_CELLS];
    let mut a = 0;
    while a < NUM_CELLS {
        let mut d = 0;
        while d < NUM_DIRS {
            let mut x = NEIGHBOR_TABLE[d][a];
            while x != NO_CELL {
                t[a][x as usize] = d as u8;
                x = NEIGHBOR_TABLE[d][x as usize];
            }
            d += 1;
        }
        a += 1;
    }
    t
}

const fn build_center_dist() -> [u8; NUM_CELLS] {
    let mut t = [0u8; NUM_CELLS];
    let mut c = 0;
    while c < NUM_CELLS {
        let q = CELL_INFO.q[c] as i32;
        let r = CELL_INFO.r[c] as i32;
        t[c] = imax(iabs(q), imax(iabs(r), iabs(q + r))) as u8;
        c += 1;
    }
    t
}

const fn build_color_class() -> [u8; NUM_CELLS] {
    let mut t = [0u8; NUM_CELLS];
    let mut c = 0;
    while c < NUM_CELLS {
        let q = CELL_INFO.q[c] as i32;
        let r = CELL_INFO.r[c] as i32;
        t[c] = (((q - r) % 3 + 3) % 3) as u8;
        c += 1;
    }
    t
}

/// Const copy of [`NEIGHBOR`] usable from other modules' `const fn`s.
pub(crate) const NEIGHBOR_TABLE: [[u8; NUM_CELLS]; NUM_DIRS] = build_neighbors();
#[allow(clippy::large_const_arrays)] // const (not static) so other const fns can read it
const RAY_TABLE: [[Bitboard; NUM_CELLS]; NUM_DIRS] = build_rays();

/// `NEIGHBOR[dir][cell]`: the adjacent cell (one step) in a direction, or [`NO_CELL`].
pub static NEIGHBOR: [[u8; NUM_CELLS]; NUM_DIRS] = NEIGHBOR_TABLE;
/// `RAYS[dir][cell]`: all cells strictly beyond `cell` in direction `dir` up to the edge.
pub static RAYS: [[Bitboard; NUM_CELLS]; NUM_DIRS] = RAY_TABLE;
/// Knight jump targets of each cell.
pub static KNIGHT_ATTACKS: [Bitboard; NUM_CELLS] = build_knight();
/// King step targets (12 neighbours: 6 orthogonal + 6 diagonal) of each cell.
pub static KING_ATTACKS: [Bitboard; NUM_CELLS] = build_king();
/// Union of the 6 orthogonal rays from each cell (rook lines on an empty board).
pub static ORTHO_LINES: [Bitboard; NUM_CELLS] = build_lines(0);
/// Union of the 6 diagonal rays from each cell (bishop lines on an empty board).
pub static DIAG_LINES: [Bitboard; NUM_CELLS] = build_lines(6);
/// `DIR_BETWEEN[a][b]`: direction from `a` towards `b` if they share a line, else [`NO_DIR`].
pub static DIR_BETWEEN: [[u8; NUM_CELLS]; NUM_CELLS] = build_dir_between();
/// Hex distance of each cell to the centre f6 (0..=5).
pub static CENTER_DIST: [u8; NUM_CELLS] = build_center_dist();
/// Colour class `((q - r) mod 3 + 3) mod 3` of each cell (f6 = 0, f1 = 1, f11 = 2).
pub static CELL_COLOR: [u8; NUM_CELLS] = build_color_class();

// ---------------------------------------------------------------------------------------
// Bit helpers

/// Single-cell bitboard.
#[inline(always)]
pub const fn bit(c: usize) -> Bitboard {
    1u128 << c
}

/// Lowest set cell (undefined result for an empty board: returns 128).
#[inline(always)]
pub fn lsb(b: Bitboard) -> usize {
    b.trailing_zeros() as usize
}

/// Highest set cell (requires a non-empty board).
#[inline(always)]
pub fn msb(b: Bitboard) -> usize {
    127 - b.leading_zeros() as usize
}

/// Removes and returns the lowest set cell (requires a non-empty board).
#[inline(always)]
pub fn pop_lsb(b: &mut Bitboard) -> usize {
    let c = b.trailing_zeros() as usize;
    *b &= *b - 1;
    c
}

/// Iterator over the cells of a bitboard, ascending.
#[derive(Clone, Copy, Debug)]
pub struct Cells(pub Bitboard);

impl Iterator for Cells {
    type Item = usize;
    #[inline(always)]
    fn next(&mut self) -> Option<usize> {
        if self.0 == 0 {
            None
        } else {
            Some(pop_lsb(&mut self.0))
        }
    }
    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        let n = self.0.count_ones() as usize;
        (n, Some(n))
    }
}

/// Iterate over the cells of a bitboard.
#[inline(always)]
pub fn cells(b: Bitboard) -> Cells {
    Cells(b)
}

// ---------------------------------------------------------------------------------------
// Sliding attacks

/// Attacks of a slider on `sq` along one direction given the occupancy: the ray up to and
/// including the first occupied cell.
#[inline(always)]
pub fn ray_attacks(dir: usize, sq: usize, occ: Bitboard) -> Bitboard {
    let ray = RAYS[dir][sq];
    let blockers = ray & occ;
    if blockers == 0 {
        return ray;
    }
    let b = if DIR_POSITIVE[dir] { lsb(blockers) } else { msb(blockers) };
    ray ^ RAYS[dir][b]
}

/// Rook attacks (6 orthogonal directions).
#[inline]
pub fn rook_attacks(sq: usize, occ: Bitboard) -> Bitboard {
    ray_attacks(DIR_N, sq, occ)
        | ray_attacks(DIR_NE, sq, occ)
        | ray_attacks(DIR_SE, sq, occ)
        | ray_attacks(DIR_S, sq, occ)
        | ray_attacks(DIR_SW, sq, occ)
        | ray_attacks(DIR_NW, sq, occ)
}

/// Bishop attacks (6 diagonal directions; a diagonal step is never blocked by the two
/// cells it passes between).
#[inline]
pub fn bishop_attacks(sq: usize, occ: Bitboard) -> Bitboard {
    ray_attacks(DIR_NNE, sq, occ)
        | ray_attacks(DIR_E, sq, occ)
        | ray_attacks(DIR_SSE, sq, occ)
        | ray_attacks(DIR_SSW, sq, occ)
        | ray_attacks(DIR_W, sq, occ)
        | ray_attacks(DIR_NNW, sq, occ)
}

/// Queen attacks (all 12 directions).
#[inline]
pub fn queen_attacks(sq: usize, occ: Bitboard) -> Bitboard {
    rook_attacks(sq, occ) | bishop_attacks(sq, occ)
}

/// Cells strictly between `a` and `b` if they share a line (orthogonal or diagonal),
/// else the empty set.
#[inline]
pub fn between(a: usize, b: usize) -> Bitboard {
    let d = DIR_BETWEEN[a][b];
    if d == NO_DIR {
        0
    } else {
        let d = d as usize;
        RAYS[d][a] ^ RAYS[d][b] ^ bit(b)
    }
}

/// The whole line through `a` and `b` (both included, edge to edge) if they are aligned,
/// else the empty set.
#[inline]
pub fn line_through(a: usize, b: usize) -> Bitboard {
    let d = DIR_BETWEEN[a][b];
    if d == NO_DIR {
        0
    } else {
        let d = d as usize;
        RAYS[d][a] | RAYS[opposite_dir(d)][a] | bit(a)
    }
}

// ---------------------------------------------------------------------------------------
// Names

/// File letter of a cell.
#[inline]
pub fn file_char(c: usize) -> char {
    FILE_LETTERS[CELL_FILE[c] as usize] as char
}

/// Appends the name of a cell (e.g. `f10`) to `out`.
pub fn push_cell_name(out: &mut String, c: usize) {
    out.push(file_char(c));
    let rank = CELL_RANK[c];
    if rank >= 10 {
        out.push('1');
        out.push((b'0' + rank - 10) as char);
    } else {
        out.push((b'0' + rank) as char);
    }
}

/// Name of a cell, e.g. `cell_name(45) == "f6"`.
pub fn cell_name(c: usize) -> String {
    let mut s = String::with_capacity(3);
    push_cell_name(&mut s, c);
    s
}

/// Parses a cell name (`a1` … `l6`, lowercase file letter, rank without leading zero).
pub fn parse_cell(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    if b.len() < 2 || b.len() > 3 {
        return None;
    }
    let file = file_index(b[0])?;
    if b[1] == b'0' {
        return None;
    }
    let mut rank = 0usize;
    for &ch in &b[1..] {
        if !ch.is_ascii_digit() {
            return None;
        }
        rank = rank * 10 + (ch - b'0') as usize;
    }
    cell_from_file_rank(file, rank)
}
