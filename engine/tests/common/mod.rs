//! Shared helpers for the integration tests.
#![allow(dead_code)]

use hexchess_engine::geometry::*;
use hexchess_engine::*;

/// Builds the FEN board field from a list like `"Kg1 kg10 Pe4 pf5"` (piece letter + cell).
pub fn board_fen(pieces: &str) -> String {
    let mut board = [' '; NUM_CELLS];
    for tok in pieces.split_whitespace() {
        let mut chars = tok.chars();
        let p = chars.next().unwrap();
        let cell = parse_cell(chars.as_str()).unwrap_or_else(|| panic!("bad cell in {tok}"));
        assert_eq!(board[cell], ' ', "two pieces on {tok}");
        board[cell] = p;
    }
    let mut s = String::new();
    for rank in (1..=11usize).rev() {
        let mut empty = 0;
        for fi in 0..NUM_FILES {
            if (FILE_LEN[fi] as usize) < rank {
                continue;
            }
            let c = FILE_OFFSET[fi] as usize + rank - 1;
            if board[c] == ' ' {
                empty += 1;
            } else {
                if empty > 0 {
                    s.push_str(&empty.to_string());
                    empty = 0;
                }
                s.push(board[c]);
            }
        }
        if empty > 0 {
            s.push_str(&empty.to_string());
        }
        if rank > 1 {
            s.push('/');
        }
    }
    s
}

/// Full FEN from a piece list and the remaining fields, e.g. `fen("Kg1 kg10", "w - 0 1")`.
pub fn fen(pieces: &str, rest: &str) -> String {
    format!("{} {}", board_fen(pieces), rest)
}

/// Strictly parsed position from a piece list.
pub fn pos(pieces: &str, rest: &str, variant: Variant) -> Position {
    let f = fen(pieces, rest);
    Position::from_fen(&f, variant).unwrap_or_else(|e| panic!("{f}: {e}"))
}

/// Cell index by name (panics if invalid).
pub fn cell(name: &str) -> usize {
    parse_cell(name).unwrap_or_else(|| panic!("bad cell {name}"))
}

/// Parses and makes a move on a position; returns the move.
pub fn play(p: &mut Position, text: &str) -> Move {
    let mv = notation::parse_move(p, text).unwrap_or_else(|| panic!("move {text} not legal/unique in {}", p.to_fen()));
    p.make(mv);
    mv
}

/// Sorted move codes of a list (for set comparisons).
pub fn sorted_codes(moves: &[Move]) -> Vec<u32> {
    let mut v: Vec<u32> = moves.iter().map(|m| m.0).collect();
    v.sort_unstable();
    v
}

/// Coordinate strings of all legal moves from a cell.
pub fn moves_from(p: &Position, from: &str) -> Vec<String> {
    let f = cell(from);
    let mut v: Vec<String> = p.legal_moves().iter().filter(|m| m.from() == f).map(|m| m.to_coord()).collect();
    v.sort();
    v
}

/// Deterministic xorshift64* generator.
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}
