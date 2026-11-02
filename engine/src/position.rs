//! [`Position`]: board state, make/unmake with an [`Undo`] record, Zobrist hashing and
//! FEN input/output (SPEC §3, §4, §5.1).

use core::fmt;

use crate::geometry::*;
use crate::variant::*;

// ---------------------------------------------------------------------------------------
// Colours and pieces (SPEC §3)

pub const WHITE: usize = 0;
pub const BLACK: usize = 1;

/// Piece kinds (SPEC §3 piece type codes). `0` = no piece.
pub const NO_PIECE: usize = 0;
pub const PAWN: usize = 1;
pub const KNIGHT: usize = 2;
pub const BISHOP: usize = 3;
pub const ROOK: usize = 4;
pub const QUEEN: usize = 5;
pub const KING: usize = 6;

/// Upper-case letter of each piece kind (index 0 unused).
pub const PIECE_LETTERS: [u8; 7] = *b"?PNBRQK";

/// Signed board code of a piece: `+kind` for White, `-kind` for Black (SPEC §3).
#[inline(always)]
pub const fn piece_code(color: usize, kind: usize) -> i8 {
    if color == WHITE {
        kind as i8
    } else {
        -(kind as i8)
    }
}

/// Kind (0..=6) of a signed board code.
#[inline(always)]
pub const fn code_kind(code: i8) -> usize {
    code.unsigned_abs() as usize
}

/// Colour of a non-zero signed board code.
#[inline(always)]
pub const fn code_color(code: i8) -> usize {
    if code < 0 {
        BLACK
    } else {
        WHITE
    }
}

/// FEN character of a signed board code (`P`…`K` white, `p`…`k` black).
pub fn code_char(code: i8) -> char {
    let c = PIECE_LETTERS[code_kind(code)] as char;
    if code < 0 {
        c.to_ascii_lowercase()
    } else {
        c
    }
}

/// `(color, kind)` of a FEN piece character.
pub fn char_piece(ch: u8) -> Option<(usize, usize)> {
    let kind = match ch.to_ascii_uppercase() {
        b'P' => PAWN,
        b'N' => KNIGHT,
        b'B' => BISHOP,
        b'R' => ROOK,
        b'Q' => QUEEN,
        b'K' => KING,
        _ => return None,
    };
    Some((if ch.is_ascii_uppercase() { WHITE } else { BLACK }, kind))
}

// ---------------------------------------------------------------------------------------
// Moves (SPEC §4)

/// A move in the ABI encoding (SPEC §4):
/// bits 0..7 from, 8..15 to, 16..19 promotion kind, 20..23 flags,
/// 24..27 moving piece kind, 28..31 captured piece kind (`PAWN` for en passant).
#[derive(Copy, Clone, PartialEq, Eq, Hash, Default)]
#[repr(transparent)]
pub struct Move(pub u32);

impl Move {
    /// "No move".
    pub const NONE: Move = Move(0);
    /// Flag bits (as stored in bits 20..23 after shifting).
    pub const CAPTURE: u32 = 1;
    pub const EN_PASSANT: u32 = 2;
    pub const DOUBLE_STEP: u32 = 4;
    pub const PROMOTION: u32 = 8;
    /// Mask of the bits matched when JS submits a move (from, to, promotion).
    pub const KEY_MASK: u32 = 0xFFFFF;

    #[inline(always)]
    pub const fn new(
        from: usize,
        to: usize,
        promo: usize,
        flags: u32,
        piece: usize,
        captured: usize,
    ) -> Move {
        Move(
            (from as u32)
                | (to as u32) << 8
                | (promo as u32) << 16
                | flags << 20
                | (piece as u32) << 24
                | (captured as u32) << 28,
        )
    }

    #[inline(always)]
    pub const fn from(self) -> usize {
        (self.0 & 0xFF) as usize
    }
    #[inline(always)]
    pub const fn to(self) -> usize {
        ((self.0 >> 8) & 0xFF) as usize
    }
    /// Promotion piece kind (0 if none).
    #[inline(always)]
    pub const fn promo(self) -> usize {
        ((self.0 >> 16) & 0xF) as usize
    }
    #[inline(always)]
    pub const fn flags(self) -> u32 {
        (self.0 >> 20) & 0xF
    }
    /// Kind of the moving piece.
    #[inline(always)]
    pub const fn piece(self) -> usize {
        ((self.0 >> 24) & 0xF) as usize
    }
    /// Kind of the captured piece (0 if none; `PAWN` for en passant).
    #[inline(always)]
    pub const fn captured(self) -> usize {
        (self.0 >> 28) as usize
    }
    #[inline(always)]
    pub const fn is_capture(self) -> bool {
        self.0 & (Move::CAPTURE << 20) != 0
    }
    #[inline(always)]
    pub const fn is_en_passant(self) -> bool {
        self.0 & (Move::EN_PASSANT << 20) != 0
    }
    #[inline(always)]
    pub const fn is_double_step(self) -> bool {
        self.0 & (Move::DOUBLE_STEP << 20) != 0
    }
    #[inline(always)]
    pub const fn is_promotion(self) -> bool {
        self.0 & (Move::PROMOTION << 20) != 0
    }
    /// Captures and promotions ("noisy" moves, as generated for quiescence).
    #[inline(always)]
    pub const fn is_noisy(self) -> bool {
        self.0 & ((Move::CAPTURE | Move::PROMOTION) << 20) != 0
    }
    /// The from/to/promotion part used to match a submitted move (`mv & 0xFFFFF`).
    #[inline(always)]
    pub const fn key(self) -> u32 {
        self.0 & Move::KEY_MASK
    }
    #[inline(always)]
    pub const fn is_none(self) -> bool {
        self.0 == 0
    }

    /// Coordinate notation, e.g. `e4e5`, `f10f11q`.
    pub fn to_coord(self) -> String {
        if self.is_none() {
            return "0000".to_string();
        }
        let mut s = String::with_capacity(7);
        push_cell_name(&mut s, self.from());
        push_cell_name(&mut s, self.to());
        if self.promo() != 0 {
            s.push((PIECE_LETTERS[self.promo()] as char).to_ascii_lowercase());
        }
        s
    }
}

impl fmt::Debug for Move {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_coord())
    }
}

impl fmt::Display for Move {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_coord())
    }
}

/// State needed to undo a move (the captured piece kind is part of the [`Move`]).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Undo {
    pub ep: u8,
    pub halfmove: u32,
    pub hash: u64,
}

// ---------------------------------------------------------------------------------------
// Zobrist keys (deterministic, generated at compile time with splitmix64)

/// Zobrist key tables.
pub struct Zobrist {
    /// `piece[color][kind][cell]` (kind index 0 unused).
    pub piece: [[[u64; NUM_CELLS]; 7]; 2],
    /// Key of an en-passant target cell (hashed only when an ep capture is available).
    pub ep: [u64; NUM_CELLS],
    /// XORed in when Black is to move.
    pub side: u64,
}

const fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

const fn build_zobrist() -> Zobrist {
    let mut z = Zobrist { piece: [[[0; NUM_CELLS]; 7]; 2], ep: [0; NUM_CELLS], side: 0 };
    let mut state: u64 = 0x4845_5843_4845_5353; // "HEXCHESS"
    let mut color = 0;
    while color < 2 {
        let mut kind = 1;
        while kind < 7 {
            let mut c = 0;
            while c < NUM_CELLS {
                z.piece[color][kind][c] = splitmix64(&mut state);
                c += 1;
            }
            kind += 1;
        }
        color += 1;
    }
    let mut c = 0;
    while c < NUM_CELLS {
        z.ep[c] = splitmix64(&mut state);
        c += 1;
    }
    z.side = splitmix64(&mut state);
    z
}

/// The Zobrist keys.
pub static ZOBRIST: Zobrist = build_zobrist();

// ---------------------------------------------------------------------------------------
// FEN errors

/// Why a FEN was rejected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FenError {
    /// No board field.
    MissingBoard,
    /// No side-to-move field.
    MissingSide,
    /// More than 5 whitespace-separated fields.
    TooManyFields,
    /// The board does not have exactly 11 ranks.
    WrongRankCount,
    /// A rank string does not describe exactly its number of cells.
    WrongCellCount { rank: usize },
    /// An unknown character in the board field.
    BadChar(char),
    /// Side to move is not `w` / `b`.
    BadSide,
    /// The en-passant field is neither `-` nor a valid cell name.
    BadEpCell,
    BadHalfmove,
    BadFullmove,
    /// Not exactly one king per side (relaxed parsing: more than one).
    KingCount,
    /// A pawn stands on its own promotion cell.
    PawnOnPromotionCell,
    /// The side that is NOT to move is in check.
    OpponentInCheck,
}

impl fmt::Display for FenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FenError::MissingBoard => f.write_str("empty FEN"),
            FenError::MissingSide => f.write_str("missing side to move (w or b)"),
            FenError::TooManyFields => f.write_str("too many fields (expected at most 5)"),
            FenError::WrongRankCount => f.write_str("the board must have exactly 11 ranks separated by '/'"),
            FenError::WrongCellCount { rank } => write!(f, "rank {rank} has the wrong number of cells"),
            FenError::BadChar(c) => write!(f, "invalid character '{c}' in the board field"),
            FenError::BadSide => f.write_str("side to move must be 'w' or 'b'"),
            FenError::BadEpCell => f.write_str("invalid en-passant cell"),
            FenError::BadHalfmove => f.write_str("invalid halfmove clock"),
            FenError::BadFullmove => f.write_str("invalid fullmove number"),
            FenError::KingCount => f.write_str("each side must have exactly one king"),
            FenError::PawnOnPromotionCell => f.write_str("a pawn stands on its promotion cell"),
            FenError::OpponentInCheck => f.write_str("the side not to move is in check"),
        }
    }
}

impl std::error::Error for FenError {}

// ---------------------------------------------------------------------------------------
// Position

/// A complete game position. `Clone` is a cheap (~300 byte) memcpy, so copy-make is also an
/// option for callers; [`Position::make`]/[`Position::unmake`] are the fast path.
#[derive(Clone, PartialEq, Eq)]
pub struct Position {
    /// Signed piece codes per cell (SPEC §3).
    pub(crate) board: [i8; NUM_CELLS],
    /// Occupancy per colour.
    pub(crate) by_color: [Bitboard; 2],
    /// Occupancy per piece kind (index 0 unused, always 0).
    pub(crate) by_kind: [Bitboard; 7],
    /// King cell per colour ([`NO_CELL`] if absent — only possible via relaxed FEN parsing).
    pub(crate) king: [u8; 2],
    pub(crate) side: usize,
    /// Cell passed over by the previous move's double step (FEN ep field), or [`NO_CELL`].
    pub(crate) ep: u8,
    pub(crate) variant: Variant,
    pub(crate) halfmove: u32,
    pub(crate) fullmove: u32,
    pub(crate) hash: u64,
}

impl fmt::Debug for Position {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Position({:?}, \"{}\")", self.variant, self.to_fen())
    }
}

impl Position {
    /// An empty board (White to move, no kings — not a legal game position).
    pub fn empty(variant: Variant) -> Position {
        Position {
            board: [0; NUM_CELLS],
            by_color: [0; 2],
            by_kind: [0; 7],
            king: [NO_CELL; 2],
            side: WHITE,
            ep: NO_CELL,
            variant,
            halfmove: 0,
            fullmove: 1,
            hash: 0,
        }
    }

    /// The variant's start position.
    pub fn start(variant: Variant) -> Position {
        match Position::from_fen(variant.start_fen(), variant) {
            Ok(p) => p,
            Err(_) => unreachable!("start FEN is valid"),
        }
    }

    // -- accessors ----------------------------------------------------------------------

    #[inline(always)]
    pub fn variant(&self) -> Variant {
        self.variant
    }
    /// Colour to move (`WHITE` / `BLACK`).
    #[inline(always)]
    pub fn side_to_move(&self) -> usize {
        self.side
    }
    /// The 91 signed piece codes (SPEC §3 board array).
    #[inline(always)]
    pub fn board(&self) -> &[i8; NUM_CELLS] {
        &self.board
    }
    /// Signed piece code on a cell.
    #[inline(always)]
    pub fn piece_at(&self, cell: usize) -> i8 {
        self.board[cell]
    }
    /// Piece kind on a cell (0 if empty).
    #[inline(always)]
    pub fn kind_at(&self, cell: usize) -> usize {
        code_kind(self.board[cell])
    }
    #[inline(always)]
    pub fn color_bb(&self, color: usize) -> Bitboard {
        self.by_color[color]
    }
    /// All pieces of a kind, both colours.
    #[inline(always)]
    pub fn kind_bb(&self, kind: usize) -> Bitboard {
        self.by_kind[kind]
    }
    #[inline(always)]
    pub fn pieces(&self, color: usize, kind: usize) -> Bitboard {
        self.by_color[color] & self.by_kind[kind]
    }
    #[inline(always)]
    pub fn occupied(&self) -> Bitboard {
        self.by_color[WHITE] | self.by_color[BLACK]
    }
    #[inline(always)]
    pub fn king_cell(&self, color: usize) -> Option<usize> {
        let k = self.king[color];
        if k == NO_CELL {
            None
        } else {
            Some(k as usize)
        }
    }
    /// The raw en-passant field: the cell passed over by the previous move's double step.
    #[inline(always)]
    pub fn ep_cell(&self) -> Option<usize> {
        if self.ep == NO_CELL {
            None
        } else {
            Some(self.ep as usize)
        }
    }
    /// The en-passant target if an en-passant capture is pseudo-legally available to the side
    /// to move (this is what the hash / repetition key and `hc_ep_cell` use).
    #[inline(always)]
    pub fn ep_capture_cell(&self) -> Option<usize> {
        if self.ep == NO_CELL {
            return None;
        }
        let x = self.ep as usize;
        let us = self.side;
        if self.variant.pawn_attacks(us ^ 1, x) & self.by_kind[PAWN] & self.by_color[us] != 0 {
            Some(x)
        } else {
            None
        }
    }
    #[inline(always)]
    pub fn halfmove_clock(&self) -> u32 {
        self.halfmove
    }
    #[inline(always)]
    pub fn fullmove_number(&self) -> u32 {
        self.fullmove
    }
    /// Incrementally maintained Zobrist hash (pieces, side to move, available ep target).
    #[inline(always)]
    pub fn hash(&self) -> u64 {
        self.hash
    }

    /// True if `color` has a knight, bishop, rook or queen.
    #[inline]
    pub fn has_non_pawn_material(&self, color: usize) -> bool {
        self.by_color[color]
            & (self.by_kind[KNIGHT] | self.by_kind[BISHOP] | self.by_kind[ROOK] | self.by_kind[QUEEN])
            != 0
    }

    /// The classical dead-draw list of SPEC §2.1: K v K, K+N v K, K+B v K.
    #[inline]
    pub fn is_insufficient_material(&self) -> bool {
        let k = &self.by_kind;
        if k[PAWN] | k[ROOK] | k[QUEEN] != 0 {
            return false;
        }
        (k[KNIGHT] | k[BISHOP]).count_ones() <= 1
    }

    /// Hash recomputed from scratch (for tests; equals [`Position::hash`]).
    pub fn compute_hash(&self) -> u64 {
        let z = &ZOBRIST;
        let mut h = 0u64;
        for c in 0..NUM_CELLS {
            let p = self.board[c];
            if p != 0 {
                h ^= z.piece[code_color(p)][code_kind(p)][c];
            }
        }
        if self.side == BLACK {
            h ^= z.side;
        }
        if let Some(x) = self.ep_capture_cell() {
            h ^= z.ep[x];
        }
        h
    }

    // -- low-level editing (keeps bitboards and board consistent; not the hash) ---------

    #[inline(always)]
    fn put(&mut self, color: usize, kind: usize, cell: usize) {
        let b = bit(cell);
        self.by_color[color] |= b;
        self.by_kind[kind] |= b;
        self.board[cell] = piece_code(color, kind);
    }

    // -- make / unmake ------------------------------------------------------------------

    /// Plays a move generated for this position (legal or pseudo-legal) and returns the
    /// undo record. Allocation-free; updates the hash incrementally.
    #[inline]
    pub fn make(&mut self, mv: Move) -> Undo {
        let undo = Undo { ep: self.ep, halfmove: self.halfmove, hash: self.hash };
        let z = &ZOBRIST;
        let us = self.side;
        let them = us ^ 1;
        let from = mv.from();
        let to = mv.to();
        let piece = mv.piece();
        let mut h = self.hash ^ z.side;
        if let Some(x) = self.ep_capture_cell() {
            h ^= z.ep[x];
        }
        if mv.is_capture() {
            let cap = mv.captured();
            let capsq = if mv.is_en_passant() { PAWN_PUSH[them][to] as usize } else { to };
            let b = bit(capsq);
            self.by_color[them] ^= b;
            self.by_kind[cap] ^= b;
            self.board[capsq] = 0;
            h ^= z.piece[them][cap][capsq];
        }
        let fb = bit(from);
        let tb = bit(to);
        self.by_color[us] ^= fb | tb;
        self.board[from] = 0;
        h ^= z.piece[us][piece][from];
        let promo = mv.promo();
        if promo != 0 {
            self.by_kind[PAWN] ^= fb;
            self.by_kind[promo] ^= tb;
            self.board[to] = piece_code(us, promo);
            h ^= z.piece[us][promo][to];
        } else {
            self.by_kind[piece] ^= fb | tb;
            self.board[to] = piece_code(us, piece);
            h ^= z.piece[us][piece][to];
            if piece == KING {
                self.king[us] = to as u8;
            }
        }
        if piece == PAWN || mv.is_capture() {
            self.halfmove = 0;
        } else {
            self.halfmove += 1;
        }
        if us == BLACK {
            self.fullmove += 1;
        }
        self.side = them;
        self.ep = NO_CELL;
        if mv.is_double_step() {
            let x = PAWN_PUSH[us][from];
            self.ep = x;
            // Hash the ep cell only if the side now to move can capture en passant.
            if self.variant.pawn_attacks(us, x as usize) & self.by_kind[PAWN] & self.by_color[them] != 0 {
                h ^= z.ep[x as usize];
            }
        }
        self.hash = h;
        undo
    }

    /// Takes back `mv`, which must be the last move made with [`Position::make`].
    #[inline]
    pub fn unmake(&mut self, mv: Move, undo: &Undo) {
        let them = self.side;
        let us = them ^ 1;
        self.side = us;
        if us == BLACK {
            self.fullmove -= 1;
        }
        let from = mv.from();
        let to = mv.to();
        let piece = mv.piece();
        let promo = mv.promo();
        let fb = bit(from);
        let tb = bit(to);
        self.by_color[us] ^= fb | tb;
        if promo != 0 {
            self.by_kind[PAWN] ^= fb;
            self.by_kind[promo] ^= tb;
        } else {
            self.by_kind[piece] ^= fb | tb;
            if piece == KING {
                self.king[us] = from as u8;
            }
        }
        self.board[from] = piece_code(us, piece);
        self.board[to] = 0;
        if mv.is_capture() {
            let cap = mv.captured();
            let capsq = if mv.is_en_passant() { PAWN_PUSH[them][to] as usize } else { to };
            self.put(them, cap, capsq);
        }
        self.ep = undo.ep;
        self.halfmove = undo.halfmove;
        self.hash = undo.hash;
    }

    /// Passes the turn (for null-move pruning). Must not be used while in check.
    #[inline]
    pub fn make_null(&mut self) -> Undo {
        let undo = Undo { ep: self.ep, halfmove: self.halfmove, hash: self.hash };
        let mut h = self.hash ^ ZOBRIST.side;
        if let Some(x) = self.ep_capture_cell() {
            h ^= ZOBRIST.ep[x];
        }
        if self.side == BLACK {
            self.fullmove += 1;
        }
        self.side ^= 1;
        self.ep = NO_CELL;
        self.halfmove += 1;
        self.hash = h;
        undo
    }

    /// Takes back [`Position::make_null`].
    #[inline]
    pub fn unmake_null(&mut self, undo: &Undo) {
        self.side ^= 1;
        if self.side == BLACK {
            self.fullmove -= 1;
        }
        self.ep = undo.ep;
        self.halfmove = undo.halfmove;
        self.hash = undo.hash;
    }

    // -- FEN ----------------------------------------------------------------------------

    /// Parses a FEN with full validation (SPEC §5.1 / `hc_load_fen`): exactly one king per
    /// side, no pawn on its own promotion cell, the side not to move not in check.
    pub fn from_fen(fen: &str, variant: Variant) -> Result<Position, FenError> {
        Position::parse_fen(fen, variant, true)
    }

    /// Parses a FEN checking only the syntax (allows a missing king, pawns on promotion
    /// cells, the side not to move in check). Used for rule fixtures and puzzles; at most
    /// one king per side is still required.
    pub fn from_fen_relaxed(fen: &str, variant: Variant) -> Result<Position, FenError> {
        Position::parse_fen(fen, variant, false)
    }

    fn parse_fen(fen: &str, variant: Variant, strict: bool) -> Result<Position, FenError> {
        let mut fields = fen.split_ascii_whitespace();
        let board = fields.next().ok_or(FenError::MissingBoard)?;
        let side = fields.next().ok_or(FenError::MissingSide)?;
        let ep = fields.next().unwrap_or("-");
        let half = fields.next().unwrap_or("0");
        let full = fields.next().unwrap_or("1");
        if fields.next().is_some() {
            return Err(FenError::TooManyFields);
        }

        let mut pos = Position::empty(variant);
        let mut rank_count = 0usize;
        for (i, rank_str) in board.split('/').enumerate() {
            if i >= 11 {
                return Err(FenError::WrongRankCount);
            }
            let rank = 11 - i;
            let mut files = [0usize; NUM_FILES];
            let mut nf = 0;
            for (fi, &len) in FILE_LEN.iter().enumerate() {
                if len as usize >= rank {
                    files[nf] = fi;
                    nf += 1;
                }
            }
            let b = rank_str.as_bytes();
            let mut j = 0;
            let mut col = 0usize;
            while j < b.len() {
                let ch = b[j];
                if ch.is_ascii_digit() {
                    if ch == b'0' {
                        return Err(FenError::WrongCellCount { rank });
                    }
                    let mut n = (ch - b'0') as usize;
                    j += 1;
                    if j < b.len() && b[j].is_ascii_digit() {
                        n = n * 10 + (b[j] - b'0') as usize;
                        j += 1;
                    }
                    col += n;
                    if col > nf {
                        return Err(FenError::WrongCellCount { rank });
                    }
                } else {
                    let (color, kind) = match char_piece(ch) {
                        Some(p) => p,
                        None => {
                            let c = rank_str[j..].chars().next().unwrap_or('?');
                            return Err(FenError::BadChar(c));
                        }
                    };
                    if col >= nf {
                        return Err(FenError::WrongCellCount { rank });
                    }
                    let cell = FILE_OFFSET[files[col]] as usize + rank - 1;
                    pos.put(color, kind, cell);
                    col += 1;
                    j += 1;
                }
            }
            if col != nf {
                return Err(FenError::WrongCellCount { rank });
            }
            rank_count += 1;
        }
        if rank_count != 11 {
            return Err(FenError::WrongRankCount);
        }

        for color in [WHITE, BLACK] {
            let kings = pos.pieces(color, KING);
            let n = kings.count_ones();
            if n > 1 || (strict && n != 1) {
                return Err(FenError::KingCount);
            }
            pos.king[color] = if n == 1 { lsb(kings) as u8 } else { NO_CELL };
        }
        if strict
            && (pos.pieces(WHITE, PAWN) & PROMOTION_CELLS[WHITE] != 0
                || pos.pieces(BLACK, PAWN) & PROMOTION_CELLS[BLACK] != 0)
        {
            return Err(FenError::PawnOnPromotionCell);
        }

        pos.side = match side {
            "w" | "W" => WHITE,
            "b" | "B" => BLACK,
            _ => return Err(FenError::BadSide),
        };

        if ep != "-" {
            let x = parse_cell(ep).ok_or(FenError::BadEpCell)?;
            // Keep only if consistent: x empty, the cell behind it (the double step's origin)
            // empty, and a pawn of the side that just moved on x + forward(that side).
            let mover = pos.side ^ 1;
            let ahead = PAWN_PUSH[mover][x];
            let behind = PAWN_PUSH[pos.side][x];
            if pos.board[x] == 0
                && ahead != NO_CELL
                && behind != NO_CELL
                && pos.board[behind as usize] == 0
                && pos.board[ahead as usize] == piece_code(mover, PAWN)
            {
                pos.ep = x as u8;
            }
        }

        pos.halfmove = parse_counter(half).ok_or(FenError::BadHalfmove)?;
        pos.fullmove = parse_counter(full).filter(|&n| n >= 1).ok_or(FenError::BadFullmove)?;
        pos.hash = pos.compute_hash();

        if strict {
            let opp = pos.side ^ 1;
            if let Some(k) = pos.king_cell(opp) {
                if pos.is_attacked(k, pos.side) {
                    return Err(FenError::OpponentInCheck);
                }
            }
        }
        Ok(pos)
    }

    /// Serialises the position as FEN (SPEC §5.1). The ep field is written whenever the
    /// previous move was a double step.
    pub fn to_fen(&self) -> String {
        let mut s = String::with_capacity(96);
        for rank in (1..=11usize).rev() {
            let mut empty = 0u32;
            for fi in 0..NUM_FILES {
                if (FILE_LEN[fi] as usize) < rank {
                    continue;
                }
                let p = self.board[FILE_OFFSET[fi] as usize + rank - 1];
                if p == 0 {
                    empty += 1;
                } else {
                    if empty > 0 {
                        s.push_str(&empty.to_string());
                        empty = 0;
                    }
                    s.push(code_char(p));
                }
            }
            if empty > 0 {
                s.push_str(&empty.to_string());
            }
            if rank > 1 {
                s.push('/');
            }
        }
        s.push(' ');
        s.push(if self.side == WHITE { 'w' } else { 'b' });
        s.push(' ');
        match self.ep_cell() {
            Some(x) => push_cell_name(&mut s, x),
            None => s.push('-'),
        }
        s.push(' ');
        s.push_str(&self.halfmove.to_string());
        s.push(' ');
        s.push_str(&self.fullmove.to_string());
        s
    }
}

fn parse_counter(s: &str) -> Option<u32> {
    if s.is_empty() || s.len() > 9 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_encoding_matches_spec_section_4() {
        let m = Move::new(33, 34, QUEEN, Move::CAPTURE | Move::PROMOTION, PAWN, ROOK);
        assert_eq!(m.0 & 0xFF, 33);
        assert_eq!((m.0 >> 8) & 0xFF, 34);
        assert_eq!((m.0 >> 16) & 0xF, 5);
        assert_eq!((m.0 >> 20) & 0xF, 1 | 8);
        assert_eq!((m.0 >> 24) & 0xF, 1);
        assert_eq!(m.0 >> 28, 4);
        assert_eq!((m.from(), m.to(), m.promo(), m.piece(), m.captured()), (33, 34, QUEEN, PAWN, ROOK));
        assert!(m.is_capture() && m.is_promotion() && !m.is_en_passant() && !m.is_double_step());
        assert_eq!(m.key(), m.0 & 0xFFFFF);
        let ep = Move::new(10, 11, 0, Move::CAPTURE | Move::EN_PASSANT, PAWN, PAWN);
        assert_eq!(ep.flags(), 3);
        assert_eq!(Move::NONE.0, 0);
        assert_eq!(Move::new(40, 42, 0, 0, BISHOP, 0).to_coord(), "f1f3");
    }

    #[test]
    fn zobrist_keys_are_distinct_and_nonzero() {
        let mut keys: Vec<u64> = Vec::new();
        for color in 0..2 {
            for kind in 1..7 {
                keys.extend_from_slice(&ZOBRIST.piece[color][kind]);
            }
        }
        keys.extend_from_slice(&ZOBRIST.ep);
        keys.push(ZOBRIST.side);
        assert!(keys.iter().all(|&k| k != 0));
        let n = keys.len();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), n);
    }
}
