//! Move notation (SPEC §5.2): SAN output and a parser for SAN and coordinate forms.
//!
//! Parser grammar (after trimming whitespace and trailing `+ # ! ?` and `e.p.`):
//! `[piece K|Q|R|B|N|P] [from-file] [from-rank] [x|:|-] to-cell [=]promo?`
//! where the promotion letter may be upper or lower case (`f11=Q`, `f10f11q`, `f10-f11=Q`).
//! Without a piece letter the move must be a pawn move, unless both the origin file and rank
//! are given (coordinate form `e4e5`, `f1c4`), in which case any piece matches. A given `x`
//! requires a capture; a missing `x` is tolerated. The text must match exactly one legal
//! move, otherwise parsing fails (illegal or ambiguous).

use crate::geometry::*;
use crate::movegen::MoveList;
use crate::position::*;

/// SAN of a legal move in `pos`, including the `+` / `#` suffix.
pub fn move_to_san(pos: &Position, mv: Move) -> String {
    let legal = pos.legal_moves();
    san_with_legal(pos, mv, &legal)
}

/// Like [`move_to_san`] but reuses an already generated legal move list of `pos`.
pub fn san_with_legal(pos: &Position, mv: Move, legal: &[Move]) -> String {
    let mut s = san_core(pos, mv, legal);
    let mut after = pos.clone();
    after.make(mv);
    if after.in_check() {
        s.push(if after.has_legal_move() { '+' } else { '#' });
    }
    s
}

/// SAN without the check suffix.
pub fn san_core(_pos: &Position, mv: Move, legal: &[Move]) -> String {
    let mut s = String::with_capacity(10);
    let from = mv.from();
    let to = mv.to();
    let piece = mv.piece();
    if piece == PAWN {
        if mv.is_capture() {
            s.push(file_char(from));
            s.push('x');
        }
        push_cell_name(&mut s, to);
        if mv.promo() != 0 {
            s.push('=');
            s.push(PIECE_LETTERS[mv.promo()] as char);
        }
        return s;
    }
    s.push(PIECE_LETTERS[piece] as char);
    let mut ambiguous = false;
    let mut same_file = false;
    let mut same_rank = false;
    for m in legal {
        if m.piece() == piece && m.to() == to && m.from() != from {
            ambiguous = true;
            if CELL_FILE[m.from()] == CELL_FILE[from] {
                same_file = true;
            }
            if CELL_RANK[m.from()] == CELL_RANK[from] {
                same_rank = true;
            }
        }
    }
    if ambiguous {
        if !same_file {
            s.push(file_char(from));
        } else if !same_rank {
            s.push_str(&CELL_RANK[from].to_string());
        } else {
            push_cell_name(&mut s, from);
        }
    }
    if mv.is_capture() {
        s.push('x');
    }
    push_cell_name(&mut s, to);
    s
}

/// Parsed form of a move text before matching it against the legal moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MovePattern {
    pub piece: Option<usize>,
    pub from_file: Option<usize>,
    pub from_rank: Option<usize>,
    pub to: usize,
    pub promo: usize,
    pub capture: bool,
}

/// Why a move text could not be resolved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseMoveError {
    /// Not a move in SAN or coordinate form.
    Syntax,
    /// Well-formed but matches no legal move.
    NoMatch,
    /// Matches more than one legal move.
    Ambiguous,
}

fn promo_kind(ch: u8) -> Option<usize> {
    match ch.to_ascii_uppercase() {
        b'Q' => Some(QUEEN),
        b'R' => Some(ROOK),
        b'B' => Some(BISHOP),
        b'N' => Some(KNIGHT),
        _ => None,
    }
}

fn piece_letter_kind(ch: u8) -> Option<usize> {
    match ch {
        b'K' => Some(KING),
        b'Q' => Some(QUEEN),
        b'R' => Some(ROOK),
        b'B' => Some(BISHOP),
        b'N' => Some(KNIGHT),
        b'P' => Some(PAWN),
        _ => None,
    }
}

fn trim_end(mut s: &[u8]) -> &[u8] {
    while let Some((&last, rest)) = s.split_last() {
        if last.is_ascii_whitespace() {
            s = rest;
        } else {
            break;
        }
    }
    s
}

/// Parses move text into a [`MovePattern`] (no position needed).
pub fn parse_pattern(text: &str) -> Option<MovePattern> {
    let mut s = text.trim().as_bytes();
    // Trailing annotations: check/mate marks, !/?, "e.p.".
    loop {
        s = trim_end(s);
        let n = s.len();
        if n >= 4 && s[n - 4..].eq_ignore_ascii_case(b"e.p.") {
            s = &s[..n - 4];
            continue;
        }
        match s.last() {
            Some(b'+' | b'#' | b'!' | b'?') => s = &s[..n - 1],
            _ => break,
        }
    }
    // Promotion suffix.
    let mut promo = 0;
    if let Some(&last) = s.last() {
        if !last.is_ascii_digit() {
            let kind = promo_kind(last)?;
            let n = s.len();
            if n >= 2 && s[n - 2] == b'=' {
                s = &s[..n - 2];
            } else if n >= 2 && s[n - 2].is_ascii_digit() {
                s = &s[..n - 1];
            } else {
                return None;
            }
            promo = kind;
        }
    }
    // Destination: 1–2 trailing digits preceded by a file letter.
    let n = s.len();
    let mut i = n;
    while i > 0 && s[i - 1].is_ascii_digit() && n - i < 2 {
        i -= 1;
    }
    if i == n || i == 0 || s[i] == b'0' {
        return None;
    }
    let rank: usize = core::str::from_utf8(&s[i..n]).ok()?.parse().ok()?;
    let file = file_index(s[i - 1])?;
    let to = cell_from_file_rank(file, rank)?;
    let mut prefix = &s[..i - 1];
    // Separator.
    let mut capture = false;
    if let Some((&last, rest)) = prefix.split_last() {
        if last == b'x' || last == b':' {
            capture = true;
            prefix = rest;
        } else if last == b'-' {
            prefix = rest;
        }
    }
    // Piece letter.
    let mut piece = None;
    if let Some((&first, rest)) = prefix.split_first() {
        if let Some(kind) = piece_letter_kind(first) {
            piece = Some(kind);
            prefix = rest;
        }
    }
    // Disambiguation: optional file letter, optional rank.
    let mut from_file = None;
    if let Some((&first, rest)) = prefix.split_first() {
        if let Some(f) = file_index(first) {
            from_file = Some(f);
            prefix = rest;
        }
    }
    let mut from_rank = None;
    if !prefix.is_empty() {
        if prefix.len() > 2 || prefix[0] == b'0' || !prefix.iter().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let r: usize = core::str::from_utf8(prefix).ok()?.parse().ok()?;
        if !(1..=11).contains(&r) {
            return None;
        }
        from_rank = Some(r);
    }
    Some(MovePattern { piece, from_file, from_rank, to, promo, capture })
}

/// Resolves a pattern against a list of legal moves.
pub fn match_pattern(pat: &MovePattern, legal: &[Move]) -> Result<Move, ParseMoveError> {
    let coordinate = pat.piece.is_none() && pat.from_file.is_some() && pat.from_rank.is_some();
    let mut found = Move::NONE;
    let mut count = 0;
    for &m in legal {
        if m.to() != pat.to || m.promo() != pat.promo {
            continue;
        }
        match pat.piece {
            Some(p) => {
                if m.piece() != p {
                    continue;
                }
            }
            None => {
                if !coordinate && m.piece() != PAWN {
                    continue;
                }
            }
        }
        if let Some(f) = pat.from_file {
            if CELL_FILE[m.from()] as usize != f {
                continue;
            }
        }
        if let Some(r) = pat.from_rank {
            if CELL_RANK[m.from()] as usize != r {
                continue;
            }
        }
        if pat.capture && !m.is_capture() {
            continue;
        }
        count += 1;
        found = m;
    }
    match count {
        0 => Err(ParseMoveError::NoMatch),
        1 => Ok(found),
        _ => Err(ParseMoveError::Ambiguous),
    }
}

/// Parses SAN or coordinate text into the unique matching legal move of `pos`.
pub fn parse_move_detailed(pos: &Position, text: &str) -> Result<Move, ParseMoveError> {
    let pat = parse_pattern(text).ok_or(ParseMoveError::Syntax)?;
    let mut legal = MoveList::new();
    pos.gen_legal(&mut legal);
    match_pattern(&pat, &legal)
}

/// Parses SAN or coordinate text; `None` if malformed, illegal or ambiguous.
pub fn parse_move(pos: &Position, text: &str) -> Option<Move> {
    parse_move_detailed(pos, text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::cell_const;

    #[test]
    fn pattern_parsing() {
        let p = parse_pattern("R1xh4+").unwrap();
        assert_eq!((p.piece, p.from_file, p.from_rank, p.to, p.capture), (Some(ROOK), None, Some(1), cell_const("h4"), true));
        let p = parse_pattern("Rf10e10").unwrap();
        assert_eq!((p.from_file, p.from_rank, p.to), (Some(5), Some(10), cell_const("e10")));
        let p = parse_pattern("f10-f11=Q").unwrap();
        assert_eq!((p.piece, p.from_file, p.from_rank, p.to, p.promo), (None, Some(5), Some(10), cell_const("f11"), QUEEN));
        let p = parse_pattern("gxf11=N#").unwrap();
        assert_eq!((p.from_file, p.to, p.promo, p.capture), (Some(6), cell_const("f11"), KNIGHT, true));
        let p = parse_pattern("Kl1").unwrap();
        assert_eq!((p.piece, p.to), (Some(KING), cell_const("l1")));
        let p = parse_pattern("kxl6").unwrap();
        assert_eq!((p.piece, p.from_file, p.to), (None, Some(9), cell_const("l6")));
        for bad in ["", "x", "Q", "=Q", "e0", "e05", "e1000", "a7", "j3", "Rk0", "R0e1", "R12e1", "e4e5=", "e4e5=K"] {
            assert!(parse_pattern(bad).is_none(), "{bad}");
        }
    }
}
